package main

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"time"
)

var (
	errQueueFull    = errors.New("too many requests are waiting")
	errQueueTimeout = errors.New("timed out waiting for a free slot")
)

// admission is a bounded queue in front of the chat worker. At most
// slots generations run at once, matching llama-server's parallel slots,
// and at most maxQueue more wait for a turn, each for at most timeout.
// Past that, requests are turned away at once instead of piling up
// inside llama-server, where they would wait unbounded and hold
// connections open. Waiters are admitted in arrival order.
type admission struct {
	slots    chan struct{}
	maxQueue int
	timeout  time.Duration

	mu      sync.Mutex
	waiting int
}

func newAdmission(slots, maxQueue int, timeout time.Duration) *admission {
	return &admission{
		slots:    make(chan struct{}, slots),
		maxQueue: maxQueue,
		timeout:  timeout,
	}
}

// acquire waits for a slot and returns the function that frees it. It
// fails with errQueueFull if the queue is full, errQueueTimeout if no
// slot frees up in time, or ctx's error if the client goes away first.
func (a *admission) acquire(ctx context.Context) (func(), error) {
	select {
	case a.slots <- struct{}{}:
		return a.admitted(0), nil
	default:
	}

	a.mu.Lock()
	if a.waiting >= a.maxQueue {
		a.mu.Unlock()
		rejected.WithLabelValues("queue_full").Inc()
		return nil, errQueueFull
	}
	a.waiting++
	queueDepth.Set(float64(a.waiting))
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.waiting--
		queueDepth.Set(float64(a.waiting))
		a.mu.Unlock()
	}()

	start := time.Now()
	timer := time.NewTimer(a.timeout)
	defer timer.Stop()
	select {
	case a.slots <- struct{}{}:
		return a.admitted(time.Since(start)), nil
	case <-timer.C:
		rejected.WithLabelValues("timeout").Inc()
		return nil, errQueueTimeout
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (a *admission) admitted(wait time.Duration) func() {
	queueWait.Observe(wait.Seconds())
	inFlight.Inc()
	var once sync.Once
	return func() {
		once.Do(func() {
			inFlight.Dec()
			<-a.slots
		})
	}
}

// admissionFailure maps an acquire error to a status code, and sets
// Retry-After so clients back off before trying again. OpenAI SDKs retry
// both statuses on their own.
func admissionFailure(w http.ResponseWriter, err error) int {
	const retryAfter = 5 * time.Second
	w.Header().Set("Retry-After",
		strconv.Itoa(int(retryAfter/time.Second)))
	if errors.Is(err, errQueueFull) {
		return http.StatusTooManyRequests
	}
	return http.StatusServiceUnavailable
}
