package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"github.com/botirk38/semanticcache"
	"github.com/botirk38/semanticcache/backends/inmemory"
	"github.com/botirk38/semanticcache/similarity"
)

// embedder adapts a llama-server embeddings worker to semanticcache's
// EmbeddingProvider interface.
type embedder struct {
	worker *worker
}

func (e embedder) EmbedText(ctx context.Context, text string) (
	[]float64, error,
) {
	return e.worker.embed(ctx, text)
}

func (e embedder) Close() error { return nil }

// responseCache maps prompts to generated responses, matching by exact
// prompt first and then by embedding similarity.
type responseCache struct {
	cache     *semanticcache.Cache[string, generateResponse]
	threshold float64
}

func newResponseCache(
	embeddings *worker, size int, threshold float64,
) (*responseCache, error) {
	backend, err := inmemory.NewLRUBackend[string, generateResponse](size)
	if err != nil {
		return nil, err
	}
	c, err := semanticcache.NewSemanticCache(
		backend, embedder{worker: embeddings}, similarity.CosineSimilarity)
	if err != nil {
		return nil, err
	}
	return &responseCache{cache: c, threshold: threshold}, nil
}

// lookup returns the cached response for prompt and its similarity score.
// An exact prompt match skips the embedding call entirely.
func (c *responseCache) lookup(ctx context.Context, prompt string) (
	resp generateResponse, score float64, ok bool, err error,
) {
	resp, ok, err = c.cache.Get(ctx, cacheKey(prompt))
	if err != nil || ok {
		return resp, 1, ok, err
	}
	match, err := c.cache.Lookup(ctx, prompt, c.threshold)
	if err != nil || match == nil {
		return resp, 0, false, err
	}
	return match.Value, match.Score, true, nil
}

func (c *responseCache) store(
	ctx context.Context, prompt string, resp generateResponse,
) error {
	return c.cache.Set(ctx, cacheKey(prompt), prompt, resp)
}

func (c *responseCache) close() error { return c.cache.Close() }

func cacheKey(prompt string) string {
	sum := sha256.Sum256([]byte(prompt))
	return hex.EncodeToString(sum[:])
}
