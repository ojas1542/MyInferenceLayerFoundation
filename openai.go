package main

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

// newOpenAIProxy serves the OpenAI-compatible API (chat completions and
// model listing) by forwarding requests to the chat worker unchanged.
// This lets OpenAI SDK clients, such as agent frameworks, use the layer
// with streaming and tool calling intact. These requests deliberately
// skip the semantic cache: agent turns depend on tool results and must
// never be answered from a cache. Completions wait their turn in queue.
func newOpenAIProxy(
	workerURL string, queue *admission,
) (http.Handler, error) {
	target, err := url.Parse(workerURL)
	if err != nil {
		return nil, err
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	// Flush every write so streamed tokens reach the client immediately.
	proxy.FlushInterval = -1
	proxy.ErrorHandler = func(
		w http.ResponseWriter, r *http.Request, err error,
	) {
		log.Printf("openai proxy %s: %v", r.URL.Path, err)
		writeOpenAIError(w, http.StatusBadGateway,
			"worker request failed", "server_error")
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
		if r.Method == http.MethodGet {
			proxy.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		release, err := queue.acquire(r.Context())
		if err != nil {
			if r.Context().Err() == nil {
				writeOpenAIError(w, admissionFailure(w, err),
					err.Error(), "rate_limit_error")
			}
			return
		}
		defer release()
		// For a streamed completion, llama-server sends the first body
		// bytes with the first generated token.
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		sw.onFirstWrite = func() {
			ct := w.Header().Get("Content-Type")
			if strings.HasPrefix(ct, "text/event-stream") {
				timeToFirstToken.
					WithLabelValues("/v1/chat/completions", "model").
					Observe(time.Since(start).Seconds())
			}
		}
		proxy.ServeHTTP(sw, r)
	}), nil
}

// writeOpenAIError writes an error in OpenAI's shape, so SDK clients can
// report it.
func writeOpenAIError(w http.ResponseWriter, status int, msg, typ string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"message": msg, "type": typ},
	})
}
