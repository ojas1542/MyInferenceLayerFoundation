package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

// Large enough for a conversation with a few attached text files.
const maxRequestBytes = 8 << 20

// generateRequest is the public request body for POST /v1/generate. It
// takes either a single prompt or a whole conversation in messages.
type generateRequest struct {
	Prompt    string         `json:"prompt,omitempty"`
	Messages  []inputMessage `json:"messages,omitempty"`
	MaxTokens int            `json:"max_tokens,omitempty"`
	Stream    bool           `json:"stream,omitempty"`
	// RefreshCache skips the cache lookup and replaces the cached answer,
	// e.g. when the user asks for the answer to be regenerated.
	RefreshCache bool `json:"refresh_cache,omitempty"`
}

type inputMessage struct {
	Role        string       `json:"role"`
	Content     string       `json:"content"`
	Attachments []attachment `json:"attachments,omitempty"`
}

// attachment is a text file attached to a message.
type attachment struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

// normalize validates in and turns a bare prompt into a one-message
// conversation. It accepts any conversation, including an empty one;
// see readyToGenerate for what a generation additionally needs.
func (in *generateRequest) normalize() error {
	if in.Prompt != "" && len(in.Messages) > 0 {
		return errors.New("use either prompt or messages, not both")
	}
	if in.MaxTokens < 0 {
		return errors.New("max_tokens must be >= 0")
	}
	if in.Prompt != "" {
		in.Messages = []inputMessage{{Role: "user", Content: in.Prompt}}
		in.Prompt = ""
	}
	for i, m := range in.Messages {
		switch m.Role {
		case "system", "user", "assistant":
		default:
			return fmt.Errorf("messages[%d]: unknown role %q", i, m.Role)
		}
		if m.Content == "" && len(m.Attachments) == 0 {
			return fmt.Errorf("messages[%d]: content is empty", i)
		}
		for j, a := range m.Attachments {
			if a.Name == "" {
				return fmt.Errorf(
					"messages[%d].attachments[%d]: name is required", i, j)
			}
		}
	}
	return nil
}

// readyToGenerate checks that a normalized request has a question to
// answer.
func (in *generateRequest) readyToGenerate() error {
	if len(in.Messages) == 0 {
		return errors.New("prompt or messages is required")
	}
	if in.Messages[len(in.Messages)-1].Role != "user" {
		return errors.New("the last message must be from the user")
	}
	return nil
}

// cachePrompt returns the prompt to use as the cache key. Only a single
// question without attachments is cached: in a longer conversation the
// right answer depends on the earlier messages, and attached files that
// differ slightly can embed almost identically.
func (in *generateRequest) cachePrompt() (string, bool) {
	if len(in.Messages) != 1 || len(in.Messages[0].Attachments) > 0 {
		return "", false
	}
	return in.Messages[0].Content, true
}

func (in *generateRequest) chatRequest() chatRequest {
	msgs := make([]chatMessage, len(in.Messages))
	for i, m := range in.Messages {
		msgs[i] = chatMessage{Role: m.Role, Content: renderContent(m)}
	}
	return chatRequest{Messages: msgs, MaxTokens: in.MaxTokens}
}

// renderContent inlines a message's attachments ahead of its text.
func renderContent(m inputMessage) string {
	if len(m.Attachments) == 0 {
		return m.Content
	}
	var b strings.Builder
	for _, a := range m.Attachments {
		fmt.Fprintf(&b, "<file name=%q>\n%s\n</file>\n\n", a.Name, a.Content)
	}
	b.WriteString(m.Content)
	return b.String()
}

// generateResponse is the public response body for POST /v1/generate.
type generateResponse struct {
	Text       string   `json:"text"`
	Reasoning  string   `json:"reasoning,omitempty"`
	Usage      usage    `json:"usage"`
	Timings    *timings `json:"timings,omitempty"`
	Cached     bool     `json:"cached"`
	Similarity float64  `json:"similarity,omitempty"`
}

type usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
}

// A streamed generation is a series of server-sent events: zero or more
// streamDelta events, then one streamDone event. A failure after the
// stream has started is sent as an {"error": "..."} event instead.
type streamDelta struct {
	Text      string `json:"text,omitempty"`
	Reasoning string `json:"reasoning,omitempty"`
}

type streamDone struct {
	Done       bool     `json:"done"`
	Usage      usage    `json:"usage"`
	Timings    *timings `json:"timings,omitempty"`
	Cached     bool     `json:"cached"`
	Similarity float64  `json:"similarity,omitempty"`
}

type server struct {
	chat       *worker
	embeddings *worker
	cache      *responseCache
	openai     http.Handler
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /v1/info", s.handleInfo)
	mux.HandleFunc("POST /v1/generate", s.handleGenerate)
	mux.HandleFunc("POST /v1/context", s.handleContext)
	mux.Handle("POST /v1/chat/completions", s.openai)
	mux.Handle("GET /v1/models", s.openai)
	return mux
}

// decodeRequest reads and normalizes a generateRequest body, writing a
// 400 response and returning false if it is invalid.
func decodeRequest(
	w http.ResponseWriter, r *http.Request,
) (generateRequest, bool) {
	var in generateRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return in, false
	}
	if err := in.normalize(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return in, false
	}
	return in, true
}

// contextUsage is the response body for POST /v1/context.
type contextUsage struct {
	// Tokens the conversation would take up as the prompt of a request,
	// before any reply is generated.
	Tokens int `json:"tokens"`
	// ContextSize is the most tokens a request, prompt plus reply, can
	// use.
	ContextSize int `json:"context_size"`
}

// handleContext reports how much of the context window a conversation
// (in the same format as POST /v1/generate) would use.
func (s *server) handleContext(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeRequest(w, r)
	if !ok {
		return
	}
	var out contextUsage
	var err error
	out.ContextSize, err = s.chat.contextSize(r.Context())
	if err == nil && len(in.Messages) > 0 {
		out.Tokens, err = s.chat.promptTokens(
			r.Context(), in.chatRequest().Messages)
	}
	if err != nil {
		log.Printf("context: %v", err)
		status, msg := workerFailure(err)
		writeError(w, status, msg)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	for _, wk := range []*worker{s.chat, s.embeddings} {
		if err := wk.health(ctx); err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) handleInfo(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	model, err := s.chat.model(ctx)
	if err != nil {
		log.Printf("info: %v", err)
		writeError(w, http.StatusBadGateway, "worker request failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"model": model})
}

func (s *server) handleGenerate(w http.ResponseWriter, r *http.Request) {
	in, ok := decodeRequest(w, r)
	if !ok {
		return
	}
	if err := in.readyToGenerate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if in.Stream {
		s.generateStream(w, r, in)
	} else {
		s.generate(w, r, in)
	}
}

func (s *server) generate(
	w http.ResponseWriter, r *http.Request, in generateRequest,
) {
	prompt, cacheable := in.cachePrompt()
	if cacheable && !in.RefreshCache {
		if hit, ok := s.cachedResponse(r.Context(), prompt); ok {
			writeJSON(w, http.StatusOK, hit)
			return
		}
	}

	// r.Context() is cancelled if the client disconnects, which aborts
	// the in-flight generation on the worker.
	out, err := s.chat.chat(r.Context(), in.chatRequest())
	if err != nil {
		log.Printf("generate: %v", err)
		status, msg := workerFailure(err)
		writeError(w, status, msg)
		return
	}
	choice := out.Choices[0]
	resp := generateResponse{
		Text:      choice.Message.Content,
		Reasoning: choice.Message.ReasoningContent,
		Usage:     out.Usage,
		Timings:   out.Timings,
	}
	if cacheable {
		s.cacheIfComplete(r.Context(), prompt, choice.FinishReason, resp)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *server) generateStream(
	w http.ResponseWriter, r *http.Request, in generateRequest,
) {
	sse := &sseWriter{w: w, rc: http.NewResponseController(w)}
	prompt, cacheable := in.cachePrompt()
	if cacheable && !in.RefreshCache {
		if hit, ok := s.cachedResponse(r.Context(), prompt); ok {
			delta := streamDelta{Text: hit.Text, Reasoning: hit.Reasoning}
			if err := sse.send(delta); err != nil {
				return
			}
			_ = sse.send(streamDone{
				Done:       true,
				Usage:      hit.Usage,
				Cached:     true,
				Similarity: hit.Similarity,
			})
			return
		}
	}

	var text, reasoning strings.Builder
	res, err := s.chat.chatStream(r.Context(), in.chatRequest(),
		func(content, rsn string) error {
			text.WriteString(content)
			reasoning.WriteString(rsn)
			return sse.send(streamDelta{Text: content, Reasoning: rsn})
		})
	if err != nil {
		log.Printf("generate stream: %v", err)
		status, msg := workerFailure(err)
		if !sse.started {
			writeError(w, status, msg)
			return
		}
		_ = sse.send(map[string]string{"error": msg})
		return
	}
	done := streamDone{Done: true, Usage: res.Usage, Timings: res.Timings}
	if err := sse.send(done); err != nil {
		log.Printf("generate stream: %v", err)
	}
	if !cacheable {
		return
	}

	// The full answer was generated, so cache it even if the client has
	// already gone away.
	ctx, cancel := context.WithTimeout(
		context.WithoutCancel(r.Context()), 5*time.Second)
	defer cancel()
	s.cacheIfComplete(ctx, prompt, res.FinishReason, generateResponse{
		Text:      text.String(),
		Reasoning: reasoning.String(),
		Usage:     res.Usage,
	})
}

// workerFailure maps a worker error to a status and client-safe message.
// A 400 from the worker means the request itself is unusable, such as a
// conversation too long for the context window, so its message is passed
// through.
func workerFailure(err error) (int, string) {
	var ue *upstreamError
	if errors.As(err, &ue) && ue.Status == http.StatusBadRequest {
		return http.StatusBadRequest, ue.Message
	}
	return http.StatusBadGateway, "worker request failed"
}

// cachedResponse returns a cached response for prompt, if any. The cache
// is an optimization, so failures are logged and treated as a miss.
func (s *server) cachedResponse(
	ctx context.Context, prompt string,
) (generateResponse, bool) {
	hit, score, ok, err := s.cache.lookup(ctx, prompt)
	if err != nil {
		log.Printf("cache lookup: %v", err)
	}
	if !ok {
		return generateResponse{}, false
	}
	hit.Cached = true
	hit.Similarity = score
	// The original generation's timings say nothing about this response.
	hit.Timings = nil
	return hit, true
}

// cacheIfComplete caches resp unless the generation was cut off, e.g. by
// max_tokens.
func (s *server) cacheIfComplete(
	ctx context.Context, prompt, finishReason string, resp generateResponse,
) {
	if finishReason != "stop" {
		return
	}
	if err := s.cache.store(ctx, prompt, resp); err != nil {
		log.Printf("cache store: %v", err)
	}
}

// sseWriter writes server-sent events, sending the response headers with
// the first event so that errors before it can still use a status code.
type sseWriter struct {
	w       http.ResponseWriter
	rc      *http.ResponseController
	started bool
}

func (s *sseWriter) send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if !s.started {
		h := s.w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		s.w.WriteHeader(http.StatusOK)
		s.started = true
	}
	if _, err := fmt.Fprintf(s.w, "data: %s\n\n", b); err != nil {
		return err
	}
	return s.rc.Flush()
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
