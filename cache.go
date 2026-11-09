package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync"

	"github.com/botirk38/semanticcache"
	"github.com/botirk38/semanticcache/backends/inmemory"
	"github.com/botirk38/semanticcache/similarity"
)

// responseCache maps prompts to generated responses, matching by exact
// prompt first and then by embedding similarity. Entries belong to the
// chat model that generated them, so switching models never serves
// another model's answers.
type responseCache interface {
	// lookup returns the cached response for prompt, if any.
	lookup(ctx context.Context, model, prompt string) (cacheHit, bool, error)
	store(ctx context.Context, model, prompt string, resp generateResponse) error
	close() error
}

type cacheHit struct {
	resp generateResponse
	// score is the cosine similarity of the matched prompt, 1 if exact.
	score float64
	exact bool
}

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

// memoryCache is an in-process LRU, cleared on restart. It only holds
// entries for the most recent model.
type memoryCache struct {
	embeddings *worker
	size       int
	threshold  float64

	mu    sync.Mutex
	model string
	cache *semanticcache.Cache[string, generateResponse]
}

func newMemoryCache(
	embeddings *worker, size int, threshold float64,
) *memoryCache {
	return &memoryCache{
		embeddings: embeddings, size: size, threshold: threshold,
	}
}

// forModel returns the cache for model, replacing the previous model's.
func (c *memoryCache) forModel(model string) (
	*semanticcache.Cache[string, generateResponse], error,
) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cache != nil && c.model == model {
		return c.cache, nil
	}
	backend, err := inmemory.NewLRUBackend[string, generateResponse](c.size)
	if err != nil {
		return nil, err
	}
	sc, err := semanticcache.NewSemanticCache(backend,
		embedder{worker: c.embeddings}, similarity.CosineSimilarity)
	if err != nil {
		return nil, err
	}
	if c.cache != nil {
		_ = c.cache.Close()
	}
	c.model, c.cache = model, sc
	return sc, nil
}

// lookup skips the embedding call entirely on an exact prompt match.
func (c *memoryCache) lookup(
	ctx context.Context, model, prompt string,
) (cacheHit, bool, error) {
	sc, err := c.forModel(model)
	if err != nil {
		return cacheHit{}, false, err
	}
	resp, ok, err := sc.Get(ctx, cacheKey(prompt))
	if err != nil || ok {
		return cacheHit{resp: resp, score: 1, exact: true}, ok, err
	}
	match, err := sc.Lookup(ctx, prompt, c.threshold)
	if err != nil || match == nil {
		return cacheHit{}, false, err
	}
	return cacheHit{resp: match.Value, score: match.Score}, true, nil
}

func (c *memoryCache) store(
	ctx context.Context, model, prompt string, resp generateResponse,
) error {
	sc, err := c.forModel(model)
	if err != nil {
		return err
	}
	return sc.Set(ctx, cacheKey(prompt), prompt, resp)
}

func (c *memoryCache) close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cache == nil {
		return nil
	}
	return c.cache.Close()
}

func cacheKey(prompt string) string {
	sum := sha256.Sum256([]byte(prompt))
	return hex.EncodeToString(sum[:])
}
