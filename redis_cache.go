package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// redisCache keeps responses in Redis, so they survive restarts and can
// be shared by several inference layers. Each entry is a hash holding
// the prompt, the response as JSON and the prompt's embedding. Semantic
// lookups are a single KNN query against a Redis Query Engine vector
// index (HNSW, cosine), rather than a scan over every cached prompt.
// Entries expire after ttl; Redis's eviction policy bounds memory.
type redisCache struct {
	client     *redis.Client
	embeddings *worker
	threshold  float64
	ttl        time.Duration

	mu      sync.Mutex
	indexes map[string]bool
}

// Field names of a cache entry hash.
const (
	fieldPrompt    = "prompt"
	fieldResponse  = "response"
	fieldEmbedding = "embedding"
)

func newRedisCache(
	ctx context.Context, url string, embeddings *worker,
	threshold float64, ttl time.Duration,
) (*redisCache, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	// go-redis only parses search replies reliably over RESP2.
	opts.Protocol = 2
	client := redis.NewClient(opts)
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("redis: %w", err)
	}
	return &redisCache{
		client:     client,
		embeddings: embeddings,
		threshold:  threshold,
		ttl:        ttl,
		indexes:    make(map[string]bool),
	}, nil
}

// prefix returns the key prefix of model's entries. The model id is
// hashed so that one model's prefix is never a prefix of another's.
func (c *redisCache) prefix(model string) string {
	sum := sha256.Sum256([]byte(model))
	return "inferencelayer:cache:" + hex.EncodeToString(sum[:6]) + ":"
}

// index returns the name of model's vector index for dim-dimensional
// embeddings, creating it if needed. Naming it by dimension means a new
// embedding model gets a fresh index instead of failing every query.
func (c *redisCache) index(
	ctx context.Context, model string, dim int,
) (string, error) {
	prefix := c.prefix(model)
	name := prefix + "idx:" + strconv.Itoa(dim)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.indexes[name] {
		return name, nil
	}
	err := c.client.FTCreate(ctx, name,
		&redis.FTCreateOptions{OnHash: true, Prefix: []any{prefix}},
		&redis.FieldSchema{
			FieldName: fieldEmbedding,
			FieldType: redis.SearchFieldTypeVector,
			VectorArgs: &redis.FTVectorArgs{
				HNSWOptions: &redis.FTHNSWOptions{
					Type:           "FLOAT32",
					Dim:            dim,
					DistanceMetric: "COSINE",
				},
			},
		},
	).Err()
	if err != nil && !strings.Contains(err.Error(), "already exists") {
		return "", fmt.Errorf("create index: %w", err)
	}
	c.indexes[name] = true
	return name, nil
}

// lookup skips the embedding call entirely on an exact prompt match.
func (c *redisCache) lookup(
	ctx context.Context, model, prompt string,
) (cacheHit, bool, error) {
	key := c.prefix(model) + cacheKey(prompt)
	raw, err := c.client.HGet(ctx, key, fieldResponse).Result()
	if err == nil {
		resp, err := decodeResponse(raw)
		return cacheHit{resp: resp, score: 1, exact: true}, err == nil, err
	}
	if !errors.Is(err, redis.Nil) {
		return cacheHit{}, false, err
	}

	emb, err := c.embeddings.embed(ctx, prompt)
	if err != nil {
		return cacheHit{}, false, err
	}
	res, err := c.nearest(ctx, model, emb)
	if isNoSuchIndex(err) {
		// The index was dropped behind our back, e.g. by FLUSHALL.
		// Recreating it indexes whatever entries remain.
		c.forgetIndex(model, len(emb))
		res, err = c.nearest(ctx, model, emb)
	}
	if err != nil {
		return cacheHit{}, false, fmt.Errorf("search: %w", err)
	}
	if len(res.Docs) == 0 {
		return cacheHit{}, false, nil
	}
	doc := res.Docs[0]
	// Cosine distance is 1 - cosine similarity.
	distance, err := strconv.ParseFloat(doc.Fields["distance"], 64)
	if err != nil {
		return cacheHit{}, false, fmt.Errorf("search: distance: %w", err)
	}
	score := 1 - distance
	if score < c.threshold {
		return cacheHit{}, false, nil
	}
	resp, err := decodeResponse(doc.Fields[fieldResponse])
	if err != nil {
		return cacheHit{}, false, err
	}
	return cacheHit{resp: resp, score: score}, true, nil
}

// nearest finds the cached prompt closest to emb.
func (c *redisCache) nearest(
	ctx context.Context, model string, emb []float64,
) (redis.FTSearchResult, error) {
	idx, err := c.index(ctx, model, len(emb))
	if err != nil {
		return redis.FTSearchResult{}, err
	}
	return c.client.FTSearchWithArgs(ctx, idx,
		"*=>[KNN 1 @embedding $vec AS distance]",
		&redis.FTSearchOptions{
			Params: map[string]any{"vec": vectorBytes(emb)},
			Return: []redis.FTSearchReturn{
				{FieldName: fieldResponse}, {FieldName: "distance"},
			},
			DialectVersion: 2,
		}).Result()
}

func (c *redisCache) forgetIndex(model string, dim int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.indexes, c.prefix(model)+"idx:"+strconv.Itoa(dim))
}

func isNoSuchIndex(err error) bool {
	return err != nil &&
		strings.Contains(strings.ToLower(err.Error()), "no such index")
}

func (c *redisCache) store(
	ctx context.Context, model, prompt string, resp generateResponse,
) error {
	emb, err := c.embeddings.embed(ctx, prompt)
	if err != nil {
		return err
	}
	// The index must exist before the entry is written to be searchable
	// without a rescan.
	if _, err := c.index(ctx, model, len(emb)); err != nil {
		return err
	}
	value, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	key := c.prefix(model) + cacheKey(prompt)
	_, err = c.client.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, key,
			fieldPrompt, prompt,
			fieldResponse, value,
			fieldEmbedding, vectorBytes(emb))
		p.Expire(ctx, key, c.ttl)
		return nil
	})
	return err
}

func (c *redisCache) close() error { return c.client.Close() }

func decodeResponse(raw string) (generateResponse, error) {
	var resp generateResponse
	if err := json.Unmarshal([]byte(raw), &resp); err != nil {
		return resp, fmt.Errorf("decode cached response: %w", err)
	}
	return resp, nil
}

// vectorBytes encodes v as little-endian float32s, the layout of a
// FLOAT32 vector field.
func vectorBytes(v []float64) []byte {
	b := make([]byte, 4*len(v))
	for i, f := range v {
		binary.LittleEndian.PutUint32(b[4*i:], math.Float32bits(float32(f)))
	}
	return b
}
