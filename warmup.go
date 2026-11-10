package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// prefixWarmer keeps the chat worker's prompt cache warm across restarts.
//
// Agent requests all start with the same tools and system prompt, several
// thousand tokens that take llama-server tens of seconds to read. The
// model is hybrid recurrent, so it can only reuse a cached prompt from a
// context checkpoint, and the server makes one where each request's last
// message starts. The warmer saves a request holding just the agent's own
// tools and latest system prompt plus a one-character user message, and
// replays it when the layer starts. That leaves a checkpoint right after
// the system prompt, so the first real request after a restart only reads
// its own messages.
//
// The chat template renders tools first, so the replay starts with just
// the tool list. Its checkpoint lets a request that adds connection tools,
// which the proxy puts last, skip re-reading the agent's own tools.
type prefixWarmer struct {
	path string

	mu    sync.Mutex
	saved []byte
}

// newPrefixWarmer returns a warmer that saves its request at path.
func newPrefixWarmer(path string) *prefixWarmer {
	return &prefixWarmer{path: path}
}

// defaultWarmupPath is where the warm-up request is kept unless
// WARMUP_FILE says otherwise. It holds the agent's system prompt, so it
// lives in the user's cache directory rather than in the repo.
func defaultWarmupPath() (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "inferencelayer", "warmup.json"), nil
}

// warmupRequest builds the warm-up request for a chat completions body:
// its tools other than connection tools and its leading system messages,
// then a one-character user message. It reports false when the body has
// no system message.
func warmupRequest(body []byte) ([]byte, bool) {
	var in struct {
		Messages []json.RawMessage `json:"messages"`
		Tools    []json.RawMessage `json:"tools"`
		// Template options can change how the prefix renders.
		ChatTemplateKwargs json.RawMessage `json:"chat_template_kwargs"`
	}
	if json.Unmarshal(body, &in) != nil {
		return nil, false
	}
	var messages []any
	for _, m := range in.Messages {
		var head struct {
			Role string `json:"role"`
		}
		if json.Unmarshal(m, &head) != nil ||
			(head.Role != "system" && head.Role != "developer") {
			break
		}
		messages = append(messages, m)
	}
	if len(messages) == 0 {
		return nil, false
	}
	out := map[string]any{
		"messages":   append(messages, chatMessage{Role: "user", Content: "."}),
		"max_tokens": 1,
	}
	var tools []json.RawMessage
	for _, tool := range in.Tools {
		if !isConnectionTool(tool) {
			tools = append(tools, tool)
		}
	}
	if len(tools) > 0 {
		out["tools"] = tools
	}
	if isJSONValue(in.ChatTemplateKwargs) {
		out["chat_template_kwargs"] = in.ChatTemplateKwargs
	}
	b, err := json.Marshal(out)
	return b, err == nil
}

func isJSONValue(raw json.RawMessage) bool {
	return len(raw) > 0 && !bytes.Equal(raw, []byte("null"))
}

// remember saves the warm-up request for a chat completions body when it
// differs from the one already saved.
func (p *prefixWarmer) remember(body []byte) error {
	req, ok := warmupRequest(body)
	if !ok {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.saved == nil {
		// Read once, so a restart does not rewrite an unchanged file.
		p.saved, _ = os.ReadFile(p.path)
	}
	if bytes.Equal(req, p.saved) {
		return nil
	}
	if err := writeFileAtomic(p.path, req); err != nil {
		return err
	}
	p.saved = req
	return nil
}

// writeFileAtomic replaces path with data, readable only by the user.
func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".warmup-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// warm sends the saved warm-up request to the chat worker at workerURL,
// after caching the part of its prompt that ends with the tool list. It
// does nothing when no request has been saved yet.
func (p *prefixWarmer) warm(
	ctx context.Context, client *http.Client, workerURL string,
) error {
	req, err := os.ReadFile(p.path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := warmTools(ctx, client, workerURL, req); err != nil {
		// The full warm-up below still helps.
		log.Printf("warmup: tools: %v", err)
	}
	start := time.Now()
	var out struct {
		Usage usage `json:"usage"`
	}
	err = postWorker(ctx, client, workerURL+"/v1/chat/completions", req, &out)
	if err != nil {
		return err
	}
	log.Printf("warmup: cached %d prompt tokens in %s",
		out.Usage.PromptTokens, time.Since(start).Round(time.Millisecond))
	return nil
}

// toolsEnd marks the end of the tool list in the chat template.
const toolsEnd = "\n</tools>"

// warmTools has the chat worker read the prompt of chat request req up
// to the end of its tool list, which leaves a context checkpoint there.
// It does nothing when the template renders no tool list.
func warmTools(
	ctx context.Context, client *http.Client, workerURL string, req []byte,
) error {
	start := time.Now()
	var tmpl struct {
		Prompt string `json:"prompt"`
	}
	err := postWorker(ctx, client, workerURL+"/apply-template", req, &tmpl)
	if err != nil {
		return err
	}
	end := strings.LastIndex(tmpl.Prompt, toolsEnd)
	if end < 0 {
		return nil
	}
	body, err := json.Marshal(map[string]any{
		"prompt":       tmpl.Prompt[:end],
		"n_predict":    0,
		"cache_prompt": true,
	})
	if err != nil {
		return err
	}
	var out struct {
		Timings struct {
			PromptN int `json:"prompt_n"`
		} `json:"timings"`
	}
	err = postWorker(ctx, client, workerURL+"/completion", body, &out)
	if err != nil {
		return err
	}
	log.Printf("warmup: cached %d tool tokens in %s", out.Timings.PromptN,
		time.Since(start).Round(time.Millisecond))
	return nil
}

// postWorker posts a JSON body to the chat worker and decodes the JSON
// answer into out.
func postWorker(
	ctx context.Context, client *http.Client, url string, body []byte,
	out any,
) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url,
		bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("%s: status %d: %s", url, resp.StatusCode, msg)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
