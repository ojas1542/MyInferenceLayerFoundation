package main

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Prometheus metrics, served at GET /metrics. Token throughput for the
// OpenAI-compatible routes comes from llama-server's own /metrics, which
// sees every generation.
var (
	httpRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "inference_http_requests_total",
		Help: "HTTP requests by route and status code.",
	}, []string{"route", "code"})

	httpDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "inference_http_request_duration_seconds",
		Help: "Time to serve an HTTP request, to the last byte.",
		Buckets: []float64{
			0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5,
			1, 2.5, 5, 10, 20, 40, 80, 160,
		},
	}, []string{"route"})

	timeToFirstToken = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "inference_time_to_first_token_seconds",
		Help: "Time from a streamed request arriving to its first token, " +
			"queueing included.",
		Buckets: []float64{
			0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5,
			1, 2, 4, 8, 16, 32, 64,
		},
	}, []string{"route", "source"})

	tokensPerSecond = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "inference_decode_tokens_per_second",
		Help: "Decode speed of each /v1/generate generation, " +
			"as measured by llama-server.",
		Buckets: []float64{5, 10, 15, 20, 25, 30, 40, 50, 75, 100},
	})

	generatedTokens = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "inference_tokens_total",
		Help: "Tokens processed by /v1/generate generations.",
	}, []string{"kind"})

	cacheLookups = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "inference_cache_lookups_total",
		Help: "Response cache lookups by result: exact, semantic, " +
			"miss or error.",
	}, []string{"result"})

	cacheLookupDuration = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "inference_cache_lookup_duration_seconds",
		Help: "Time to look up a prompt in the response cache.",
		Buckets: []float64{
			0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25,
		},
	})

	queueDepth = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "inference_queue_depth",
		Help: "Requests waiting for a chat worker slot.",
	})

	inFlight = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "inference_in_flight",
		Help: "Requests holding a chat worker slot.",
	})

	queueWait = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "inference_queue_wait_seconds",
		Help: "Time admitted requests waited for a chat worker slot.",
		// The 0 bucket counts requests that found a slot free at once.
		Buckets: []float64{
			0, 0.001, 0.01, 0.1, 0.5, 1, 2.5, 5, 10, 20, 40, 80, 160,
		},
	})

	rejected = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "inference_rejected_total",
		Help: "Requests turned away by admission control, by reason: " +
			"queue_full or timeout.",
	}, []string{"reason"})
)

// instrument records the count and duration of every request, labelled
// with the route pattern that served it.
func instrument(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		// ServeMux sets the matched pattern on r while routing it.
		route := r.Pattern
		if route == "" {
			route = "unmatched"
		}
		httpRequests.WithLabelValues(route, strconv.Itoa(sw.status)).Inc()
		httpDuration.WithLabelValues(route).
			Observe(time.Since(start).Seconds())
	})
}

// statusWriter remembers the status code written to a response, and
// calls onFirstWrite before the first byte of the body.
type statusWriter struct {
	http.ResponseWriter
	status       int
	wroteHeader  bool
	wroteBody    bool
	onFirstWrite func()
}

func (w *statusWriter) WriteHeader(status int) {
	if !w.wroteHeader {
		w.status = status
		w.wroteHeader = true
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	w.wroteHeader = true
	if !w.wroteBody {
		w.wroteBody = true
		if w.onFirstWrite != nil {
			w.onFirstWrite()
		}
	}
	return w.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the underlying writer, so
// streamed responses can still be flushed.
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
