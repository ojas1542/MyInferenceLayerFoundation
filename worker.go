package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Subset of llama-server's OpenAI-compatible chat completions schema.
type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Messages      []chatMessage  `json:"messages"`
	MaxTokens     int            `json:"max_tokens,omitempty"`
	Stream        bool           `json:"stream,omitempty"`
	StreamOptions *streamOptions `json:"stream_options,omitempty"`
}

type streamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

// chatChunk is one server-sent event of a streamed chat completion.
type chatChunk struct {
	Choices []struct {
		Delta struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage   *usage   `json:"usage"`
	Timings *timings `json:"timings"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage   usage    `json:"usage"`
	Timings *timings `json:"timings"`
}

// timings is llama-server's own measurement of a generation.
type timings struct {
	PromptMs           float64 `json:"prompt_ms"`
	PredictedMs        float64 `json:"predicted_ms"`
	PredictedPerSecond float64 `json:"predicted_per_second"`
}

// streamResult summarizes a finished streamed chat completion.
type streamResult struct {
	FinishReason string
	Usage        usage
	Timings      *timings
}

// Subset of llama-server's OpenAI-compatible embeddings schema.
type embeddingRequest struct {
	Input string `json:"input"`
}

type embeddingResponse struct {
	Data []struct {
		Embedding []float64 `json:"embedding"`
	} `json:"data"`
}

// worker talks to a single llama-server instance.
type worker struct {
	baseURL string
	client  *http.Client
}

func (w *worker) health(ctx context.Context) error {
	req, err := http.NewRequestWithContext(
		ctx, http.MethodGet, w.baseURL+"/health", nil)
	if err != nil {
		return err
	}
	resp, err := w.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s health: status %d", w.baseURL, resp.StatusCode)
	}
	return nil
}

func (w *worker) chat(
	ctx context.Context, in chatRequest,
) (chatResponse, error) {
	var out chatResponse
	if err := w.post(ctx, "/v1/chat/completions", in, &out); err != nil {
		return out, fmt.Errorf("worker chat: %w", err)
	}
	if len(out.Choices) == 0 {
		return out, errors.New("worker chat: no choices")
	}
	return out, nil
}

// chatStream runs a streamed chat completion, calling onDelta for each
// piece of generated text. An error from onDelta stops the stream and is
// returned as is.
func (w *worker) chatStream(
	ctx context.Context, in chatRequest,
	onDelta func(content, reasoning string) error,
) (streamResult, error) {
	var res streamResult
	in.Stream = true
	in.StreamOptions = &streamOptions{IncludeUsage: true}
	resp, err := w.do(ctx, "/v1/chat/completions", in)
	if err != nil {
		return res, fmt.Errorf("worker chat stream: %w", err)
	}
	defer resp.Body.Close()

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		data, ok := strings.CutPrefix(sc.Text(), "data: ")
		if !ok {
			continue
		}
		if data == "[DONE]" {
			return res, nil
		}
		var c chatChunk
		if err := json.Unmarshal([]byte(data), &c); err != nil {
			return res, fmt.Errorf("worker chat stream: decode: %w", err)
		}
		if c.Usage != nil {
			res.Usage = *c.Usage
		}
		if c.Timings != nil {
			res.Timings = c.Timings
		}
		for _, ch := range c.Choices {
			if ch.FinishReason != nil {
				res.FinishReason = *ch.FinishReason
			}
			d := ch.Delta
			if d.Content == "" && d.ReasoningContent == "" {
				continue
			}
			if err := onDelta(d.Content, d.ReasoningContent); err != nil {
				return res, err
			}
		}
	}
	if err := sc.Err(); err != nil {
		return res, fmt.Errorf("worker chat stream: %w", err)
	}
	return res, errors.New("worker chat stream: ended without [DONE]")
}

func (w *worker) embed(ctx context.Context, text string) ([]float64, error) {
	var out embeddingResponse
	err := w.post(ctx, "/v1/embeddings", embeddingRequest{Input: text}, &out)
	if err != nil {
		return nil, fmt.Errorf("worker embed: %w", err)
	}
	if len(out.Data) == 0 || len(out.Data[0].Embedding) == 0 {
		return nil, errors.New("worker embed: empty embedding")
	}
	return out.Data[0].Embedding, nil
}

// do POSTs in as JSON and returns the response if its status is 200 OK.
// The caller must close the response body.
func (w *worker) do(
	ctx context.Context, path string, in any,
) (*http.Response, error) {
	body, err := json.Marshal(in)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		w.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := w.client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		return nil, readUpstreamError(resp)
	}
	return resp, nil
}

// upstreamError is a non-200 response from llama-server.
type upstreamError struct {
	Status  int
	Message string
}

func (e *upstreamError) Error() string {
	return fmt.Sprintf("status %d: %s", e.Status, e.Message)
}

func readUpstreamError(resp *http.Response) error {
	var body struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	msg := strings.TrimSpace(string(b))
	if json.Unmarshal(b, &body) == nil && body.Error.Message != "" {
		msg = body.Error.Message
	}
	return &upstreamError{Status: resp.StatusCode, Message: msg}
}

// model returns the id of the model the worker is serving.
func (w *worker) model(ctx context.Context) (string, error) {
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := w.get(ctx, "/v1/models", &out); err != nil {
		return "", fmt.Errorf("worker models: %w", err)
	}
	if len(out.Data) == 0 {
		return "", errors.New("worker models: no models")
	}
	return out.Data[0].ID, nil
}

// contextSize returns the context window of each of the worker's slots,
// i.e. the most tokens a single request can use.
func (w *worker) contextSize(ctx context.Context) (int, error) {
	var out struct {
		Settings struct {
			NCtx int `json:"n_ctx"`
		} `json:"default_generation_settings"`
	}
	if err := w.get(ctx, "/props", &out); err != nil {
		return 0, fmt.Errorf("worker props: %w", err)
	}
	if out.Settings.NCtx <= 0 {
		return 0, errors.New("worker props: no context size")
	}
	return out.Settings.NCtx, nil
}

// promptTokens counts the tokens msgs take up as a prompt, formatted
// with the model's chat template exactly as a chat request would be.
func (w *worker) promptTokens(
	ctx context.Context, msgs []chatMessage,
) (int, error) {
	var prompt struct {
		Prompt string `json:"prompt"`
	}
	in := map[string]any{"messages": msgs}
	if err := w.post(ctx, "/apply-template", in, &prompt); err != nil {
		return 0, fmt.Errorf("worker apply-template: %w", err)
	}
	var tokens struct {
		Tokens []json.RawMessage `json:"tokens"`
	}
	in = map[string]any{"content": prompt.Prompt, "parse_special": true}
	if err := w.post(ctx, "/tokenize", in, &tokens); err != nil {
		return 0, fmt.Errorf("worker tokenize: %w", err)
	}
	return len(tokens.Tokens), nil
}

func (w *worker) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(
		ctx, http.MethodGet, w.baseURL+path, nil)
	if err != nil {
		return err
	}
	resp, err := w.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return readUpstreamError(resp)
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	return nil
}

func (w *worker) post(ctx context.Context, path string, in, out any) error {
	resp, err := w.do(ctx, path, in)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	return nil
}
