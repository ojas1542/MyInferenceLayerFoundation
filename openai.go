package main

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// newOpenAIProxy serves the OpenAI-compatible API (chat completions and
// model listing) by forwarding requests to the chat worker unchanged.
// This lets OpenAI SDK clients, such as agent frameworks, use the layer
// with streaming and tool calling intact. These requests deliberately
// skip the semantic cache: agent turns depend on tool results and must
// never be answered from a cache.
func newOpenAIProxy(workerURL string) (http.Handler, error) {
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
		// Errors use OpenAI's shape so SDK clients can report them.
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": map[string]string{
				"message": "worker request failed",
				"type":    "server_error",
			},
		})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
		proxy.ServeHTTP(w, r)
	}), nil
}
