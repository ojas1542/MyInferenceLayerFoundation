package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var agentTools = []map[string]any{{
	"type":     "function",
	"function": map[string]any{"name": "weather"},
}}

func agentRequest(question string) map[string]any {
	return map[string]any{
		"messages": []map[string]any{
			{"role": "system", "content": "You are Eve."},
			{"role": "user", "content": "Current date and time: now."},
			{"role": "user", "content": question},
		},
		"tools":       agentTools,
		"tool_choice": "auto",
		"stream":      true,
	}
}

func TestWarmupRequest(t *testing.T) {
	body, _ := json.Marshal(agentRequest(question))
	got, ok := warmupRequest(body)
	if !ok {
		t.Fatal("no warm-up request for an agent request")
	}
	var out struct {
		Messages  []chatMessage    `json:"messages"`
		Tools     []map[string]any `json:"tools"`
		MaxTokens int              `json:"max_tokens"`
		Stream    bool             `json:"stream"`
	}
	if err := json.Unmarshal(got, &out); err != nil {
		t.Fatal(err)
	}
	want := []chatMessage{
		{Role: "system", Content: "You are Eve."},
		{Role: "user", Content: "."},
	}
	if len(out.Messages) != 2 || out.Messages[0] != want[0] ||
		out.Messages[1] != want[1] {
		t.Fatalf("messages = %+v, want %+v", out.Messages, want)
	}
	if len(out.Tools) != 1 || out.MaxTokens != 1 || out.Stream {
		t.Fatalf("tools %v, max_tokens %d, stream %v",
			out.Tools, out.MaxTokens, out.Stream)
	}

	noSystem, _ := json.Marshal(map[string]any{
		"messages": []chatMessage{{Role: "user", Content: question}},
	})
	if _, ok := warmupRequest(noSystem); ok {
		t.Fatal("warm-up request built without a system message")
	}
}

func TestPrefixWarmup(t *testing.T) {
	llama, llamaSrv := newFakeLlama(t)
	path := filepath.Join(t.TempDir(), "cache", "warmup.json")
	queue := newAdmission(4, 4, time.Second)
	openai, err := newOpenAIProxy(llamaSrv.URL, queue, newPrefixWarmer(path))
	if err != nil {
		t.Fatal(err)
	}
	wk := &worker{baseURL: llamaSrv.URL, client: llamaSrv.Client()}
	s := &server{chat: wk, embeddings: wk, queue: queue, openai: openai,
		cache: newMemoryCache(wk, 100, 0.95)}
	srv := httptest.NewServer(instrument(s.routes()))
	t.Cleanup(srv.Close)

	// The request still reaches the worker intact.
	resp := postJSON(t, srv.URL+"/v1/chat/completions",
		agentRequest(question))
	answer, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || llama.chats.Load() != 1 ||
		!strings.Contains(string(answer), "answer to "+question) {
		t.Fatalf("completion: status %d, chats %d, body %s",
			resp.StatusCode, llama.chats.Load(), answer)
	}
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("warm-up file mode %v, want 0600", info.Mode().Perm())
	}

	// A later turn with the same prefix leaves the file alone.
	before := info.ModTime()
	time.Sleep(10 * time.Millisecond)
	postJSON(t, srv.URL+"/v1/chat/completions", agentRequest(unrelated))
	if info, _ := os.Stat(path); !info.ModTime().Equal(before) {
		t.Fatal("unchanged prefix rewrote the warm-up file")
	}

	// After a restart, warming sends the saved request.
	err = newPrefixWarmer(path).warm(
		context.Background(), llamaSrv.Client(), llamaSrv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if got := llama.lastChat.Load(); string(got.([]byte)) != string(saved) {
		t.Fatalf("warm-up sent %s, want %s", got, saved)
	}

	// Nothing is sent before any request has been saved.
	chats := llama.chats.Load()
	missing := newPrefixWarmer(filepath.Join(t.TempDir(), "none.json"))
	if err := missing.warm(context.Background(), llamaSrv.Client(),
		llamaSrv.URL); err != nil || llama.chats.Load() != chats {
		t.Fatalf("warm without a saved request: %v, chats %d -> %d",
			err, chats, llama.chats.Load())
	}
}
