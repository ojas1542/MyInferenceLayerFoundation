package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	dto "github.com/prometheus/client_model/go"
)

// Prompts with hand-picked embeddings: the paraphrase is close to the
// question (cosine about 0.99), the other prompt is not.
const (
	question   = "What is the capital of France?"
	paraphrase = "whats the capital of france"
	unrelated  = "Write a haiku about rain"
)

var embeddingsByText = map[string][]float64{
	question:   {1, 0, 0, 0},
	paraphrase: {0.99, 0.14, 0, 0},
	unrelated:  {0, 0, 1, 0},
}

// fakeLlama stands in for both llama-server workers.
type fakeLlama struct {
	model atomic.Value // string
	chats atomic.Int32
	// gate, if set, holds every chat completion until it is closed.
	gate chan struct{}
}

func newFakeLlama(t *testing.T) (*fakeLlama, *httptest.Server) {
	f := &fakeLlama{}
	f.model.Store("model-a")
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeLlama) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/health":
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	case "/v1/models":
		writeJSON(w, http.StatusOK, map[string]any{
			"data": []map[string]string{{"id": f.model.Load().(string)}},
		})
	case "/v1/embeddings":
		var in embeddingRequest
		_ = json.NewDecoder(r.Body).Decode(&in)
		emb, ok := embeddingsByText[in.Input]
		if !ok {
			emb = []float64{0, 0, 0, 1}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"data": []map[string]any{{"embedding": emb}},
		})
	case "/v1/chat/completions":
		f.chats.Add(1)
		if f.gate != nil {
			select {
			case <-f.gate:
			case <-r.Context().Done():
				return
			}
		}
		var in chatRequest
		_ = json.NewDecoder(r.Body).Decode(&in)
		answer := "answer to " + in.Messages[len(in.Messages)-1].Content
		if in.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":"+
				"{\"content\":%q}}]}\n\n", answer)
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},"+
				"\"finish_reason\":\"stop\"}],\"usage\":"+
				"{\"prompt_tokens\":5,\"completion_tokens\":3}}\n\n")
			fmt.Fprint(w, "data: [DONE]\n\n")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"choices": []map[string]any{{
				"message":       map[string]string{"content": answer},
				"finish_reason": "stop",
			}},
			"usage":   map[string]int{"prompt_tokens": 5, "completion_tokens": 3},
			"timings": map[string]float64{"predicted_per_second": 20},
		})
	default:
		http.NotFound(w, r)
	}
}

func newTestServer(
	t *testing.T, llama *httptest.Server, cache responseCache,
	queue *admission,
) *httptest.Server {
	t.Helper()
	wk := &worker{baseURL: llama.URL, client: llama.Client()}
	openai, err := newOpenAIProxy(llama.URL, queue)
	if err != nil {
		t.Fatal(err)
	}
	s := &server{
		chat: wk, embeddings: wk, cache: cache, queue: queue, openai: openai,
	}
	srv := httptest.NewServer(instrument(s.routes()))
	t.Cleanup(srv.Close)
	return srv
}

func postJSON(t *testing.T, url string, body any) *http.Response {
	t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func generate(t *testing.T, srv *httptest.Server, prompt string) (
	generateResponse, int,
) {
	t.Helper()
	resp := postJSON(t, srv.URL+"/v1/generate",
		map[string]string{"prompt": prompt})
	var out generateResponse
	if resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
	}
	return out, resp.StatusCode
}

// testCache runs the behavior every responseCache must have.
func testCache(t *testing.T, newCache func(*worker) responseCache) {
	llama, llamaSrv := newFakeLlama(t)
	wk := &worker{baseURL: llamaSrv.URL, client: llamaSrv.Client()}
	cache := newCache(wk)
	srv := newTestServer(t, llamaSrv, cache, newAdmission(1, 1, time.Second))

	first, _ := generate(t, srv, question)
	if first.Cached || llama.chats.Load() != 1 {
		t.Fatalf("first request: cached=%v chats=%d",
			first.Cached, llama.chats.Load())
	}

	exact, _ := generate(t, srv, question)
	if !exact.Cached || exact.Similarity != 1 || exact.Text != first.Text {
		t.Fatalf("exact repeat: %+v", exact)
	}

	similar, _ := generate(t, srv, paraphrase)
	if !similar.Cached || similar.Similarity < 0.95 ||
		similar.Similarity >= 1 || similar.Text != first.Text {
		t.Fatalf("paraphrase: %+v", similar)
	}

	other, _ := generate(t, srv, unrelated)
	if other.Cached {
		t.Fatalf("unrelated prompt was answered from the cache")
	}
	if llama.chats.Load() != 2 {
		t.Fatalf("chats = %d, want 2", llama.chats.Load())
	}

	// A cache that loses its index, as Redis does on FLUSHALL, rebuilds
	// it from the entries it still holds.
	if rc, ok := cache.(*redisCache); ok {
		idx, _ := rc.client.FT_List(t.Context()).Result()
		for _, name := range idx {
			if strings.HasPrefix(name, rc.prefix("model-a")) {
				rc.client.FTDropIndex(t.Context(), name)
			}
		}
		if again, _ := generate(t, srv, paraphrase); !again.Cached {
			t.Fatalf("paraphrase after the index was dropped: %+v", again)
		}
	}

	// Another model's answers are never served.
	llama.model.Store("model-b")
	if switched, _ := generate(t, srv, question); switched.Cached {
		t.Fatalf("served model-a's answer for model-b")
	}
}

func TestMemoryCache(t *testing.T) {
	testCache(t, func(wk *worker) responseCache {
		return newMemoryCache(wk, 100, 0.95)
	})
}

// TestRedisCache needs Redis 8 or Redis Stack, e.g.
// TEST_REDIS_URL=redis://127.0.0.1:6379 go test ./...
func TestRedisCache(t *testing.T) {
	url := os.Getenv("TEST_REDIS_URL")
	if url == "" {
		t.Skip("TEST_REDIS_URL is not set")
	}
	testCache(t, func(wk *worker) responseCache {
		c, err := newRedisCache(t.Context(), url, wk, 0.95, time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			ctx := context.Background()
			for _, model := range []string{"model-a", "model-b"} {
				prefix := c.prefix(model)
				keys, _ := c.client.Keys(ctx, prefix+"*").Result()
				if len(keys) > 0 {
					c.client.Del(ctx, keys...)
				}
				idx, _ := c.client.FT_List(ctx).Result()
				for _, name := range idx {
					if strings.HasPrefix(name, prefix) {
						c.client.FTDropIndex(ctx, name)
					}
				}
			}
			_ = c.close()
		})
		return c
	})
}

func TestCacheHitsSkipTheQueue(t *testing.T) {
	llama, llamaSrv := newFakeLlama(t)
	wk := &worker{baseURL: llamaSrv.URL, client: llamaSrv.Client()}
	queue := newAdmission(1, 0, time.Second)
	srv := newTestServer(t, llamaSrv, newMemoryCache(wk, 100, 0.95), queue)
	generate(t, srv, question)

	// With the only slot taken and no room to wait, a generation is
	// turned away but a cached answer is still served.
	release, err := queue.acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if hit, status := generate(t, srv, question); !hit.Cached {
		t.Fatalf("cached prompt: status %d", status)
	}
	if _, status := generate(t, srv, unrelated); status != 429 {
		t.Fatalf("uncached prompt: status %d, want 429", status)
	}
	if llama.chats.Load() != 1 {
		t.Fatalf("chats = %d, want 1", llama.chats.Load())
	}
}

func TestAdmission(t *testing.T) {
	q := newAdmission(1, 1, 50*time.Millisecond)
	release, err := q.acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	// The second request waits; a third finds the queue full.
	waited := make(chan error, 1)
	go func() {
		r, err := q.acquire(t.Context())
		if err == nil {
			r()
		}
		waited <- err
	}()
	waitFor(t, func() bool { return testutil.ToFloat64(queueDepth) == 1 })
	if _, err := q.acquire(t.Context()); !errors.Is(err, errQueueFull) {
		t.Fatalf("third acquire: %v, want errQueueFull", err)
	}
	// The waiter times out while the slot is still held.
	if err := <-waited; !errors.Is(err, errQueueTimeout) {
		t.Fatalf("waiter: %v, want errQueueTimeout", err)
	}

	// Freeing the slot admits the next waiter.
	go func() {
		r, err := q.acquire(t.Context())
		if err == nil {
			r()
		}
		waited <- err
	}()
	waitFor(t, func() bool { return testutil.ToFloat64(queueDepth) == 1 })
	release()
	release() // releasing twice is harmless
	if err := <-waited; err != nil {
		t.Fatalf("waiter after release: %v", err)
	}
	if got := testutil.ToFloat64(inFlight); got != 0 {
		t.Fatalf("in flight = %v, want 0", got)
	}

	// A client that goes away stops waiting.
	release, _ = q.acquire(t.Context())
	defer release()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := q.acquire(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled acquire: %v", err)
	}
}

func TestOpenAIProxyBackPressure(t *testing.T) {
	llama, llamaSrv := newFakeLlama(t)
	llama.gate = make(chan struct{})
	wk := &worker{baseURL: llamaSrv.URL, client: llamaSrv.Client()}
	srv := newTestServer(t, llamaSrv, newMemoryCache(wk, 100, 0.95),
		newAdmission(1, 0, time.Second))

	body := map[string]any{
		"messages": []chatMessage{{Role: "user", Content: question}},
		"stream":   true,
	}
	var wg sync.WaitGroup
	wg.Go(func() {
		resp := postJSON(t, srv.URL+"/v1/chat/completions", body)
		if resp.StatusCode != http.StatusOK {
			t.Errorf("first completion: status %d", resp.StatusCode)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
	})
	waitFor(t, func() bool { return llama.chats.Load() == 1 })

	resp := postJSON(t, srv.URL+"/v1/chat/completions", body)
	var out struct {
		Error struct {
			Type string `json:"type"`
		} `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode != http.StatusTooManyRequests ||
		resp.Header.Get("Retry-After") == "" ||
		out.Error.Type != "rate_limit_error" {
		t.Fatalf("second completion: status %d, Retry-After %q, type %q",
			resp.StatusCode, resp.Header.Get("Retry-After"), out.Error.Type)
	}
	close(llama.gate)
	wg.Wait()

	// Listing models never queues.
	resp, err := http.Get(srv.URL + "/v1/models")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("models: %v %v", err, resp.Status)
	}
	resp.Body.Close()
}

func TestMetrics(t *testing.T) {
	_, llamaSrv := newFakeLlama(t)
	wk := &worker{baseURL: llamaSrv.URL, client: llamaSrv.Client()}
	srv := newTestServer(t, llamaSrv, newMemoryCache(wk, 100, 0.95),
		newAdmission(1, 1, time.Second))

	exactHits := cacheLookups.WithLabelValues("exact")
	hits := testutil.ToFloat64(exactHits)
	modelTTFT := timeToFirstToken.WithLabelValues("/v1/generate", "model")
	ttft := sampleCount(t, modelTTFT)
	generate(t, srv, unrelated)
	generate(t, srv, unrelated)
	resp := postJSON(t, srv.URL+"/v1/generate",
		map[string]any{"prompt": question, "stream": true})
	_, _ = io.Copy(io.Discard, resp.Body)

	if got := testutil.ToFloat64(exactHits); got != hits+1 {
		t.Errorf("exact hits = %v, want %v", got, hits+1)
	}
	if sampleCount(t, modelTTFT) != ttft+1 {
		t.Errorf("no time to first token was recorded")
	}

	resp, err := http.Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	for _, want := range []string{
		`inference_http_requests_total{code="200",route="POST /v1/generate"}`,
		`inference_tokens_total{kind="completion"}`,
		`inference_decode_tokens_per_second_count`,
		`inference_time_to_first_token_seconds_count{` +
			`route="/v1/generate",source="model"}`,
		`inference_queue_depth`,
	} {
		if !bytes.Contains(b, []byte(want)) {
			t.Errorf("/metrics is missing %s", want)
		}
	}
}

// sampleCount returns how many observations a histogram has recorded.
func sampleCount(t *testing.T, o prometheus.Observer) uint64 {
	t.Helper()
	var m dto.Metric
	if err := o.(prometheus.Metric).Write(&m); err != nil {
		t.Fatal(err)
	}
	return m.GetHistogram().GetSampleCount()
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for condition")
		}
		time.Sleep(time.Millisecond)
	}
}
