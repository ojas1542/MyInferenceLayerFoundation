// Command inferencelayer is a minimal HTTP API in front of llama.cpp
// llama-server workers, with a semantic response cache, admission control
// and Prometheus metrics.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

type config struct {
	addr           string
	llamaURL       string
	embedURL       string
	cacheSize      int
	cacheThreshold float64
	// redisURL, if set, keeps the cache in Redis instead of in memory.
	redisURL string
	cacheTTL time.Duration
	// Admission control: generations running at once, how many more may
	// wait, and for how long.
	maxConcurrent int
	maxQueue      int
	queueTimeout  time.Duration
}

func loadConfig() (config, error) {
	cfg := config{
		addr:     envOr("ADDR", ":9000"),
		llamaURL: envOr("LLAMA_URL", "http://127.0.0.1:8080"),
		embedURL: envOr("EMBED_URL", "http://127.0.0.1:8081"),
		redisURL: os.Getenv("REDIS_URL"),
	}
	var err error
	cfg.cacheSize, err = strconv.Atoi(envOr("CACHE_SIZE", "1000"))
	if err != nil || cfg.cacheSize <= 0 {
		return cfg, fmt.Errorf("CACHE_SIZE must be a positive integer")
	}
	cfg.cacheThreshold, err = strconv.ParseFloat(
		envOr("CACHE_THRESHOLD", "0.95"), 64)
	if err != nil || cfg.cacheThreshold <= 0 || cfg.cacheThreshold > 1 {
		return cfg, fmt.Errorf("CACHE_THRESHOLD must be in (0, 1]")
	}
	cfg.cacheTTL, err = time.ParseDuration(envOr("CACHE_TTL", "168h"))
	if err != nil || cfg.cacheTTL <= 0 {
		return cfg, fmt.Errorf("CACHE_TTL must be a positive duration")
	}
	cfg.maxConcurrent, err = strconv.Atoi(envOr("MAX_CONCURRENT", "4"))
	if err != nil || cfg.maxConcurrent <= 0 {
		return cfg, fmt.Errorf("MAX_CONCURRENT must be a positive integer")
	}
	cfg.maxQueue, err = strconv.Atoi(envOr("MAX_QUEUE", "16"))
	if err != nil || cfg.maxQueue < 0 {
		return cfg, fmt.Errorf("MAX_QUEUE must be a non-negative integer")
	}
	cfg.queueTimeout, err = time.ParseDuration(envOr("QUEUE_TIMEOUT", "60s"))
	if err != nil || cfg.queueTimeout <= 0 {
		return cfg, fmt.Errorf("QUEUE_TIMEOUT must be a positive duration")
	}
	return cfg, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func newCache(cfg config, embeddings *worker) (responseCache, error) {
	if cfg.redisURL == "" {
		log.Printf("cache: in memory, %d entries", cfg.cacheSize)
		return newMemoryCache(
			embeddings, cfg.cacheSize, cfg.cacheThreshold), nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	log.Printf("cache: redis, entries kept for %s", cfg.cacheTTL)
	return newRedisCache(
		ctx, cfg.redisURL, embeddings, cfg.cacheThreshold, cfg.cacheTTL)
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	client := &http.Client{}
	chat := &worker{baseURL: cfg.llamaURL, client: client}
	embeddings := &worker{baseURL: cfg.embedURL, client: client}
	cache, err := newCache(cfg, embeddings)
	if err != nil {
		log.Fatalf("cache: %v", err)
	}
	defer cache.close()
	queue := newAdmission(cfg.maxConcurrent, cfg.maxQueue, cfg.queueTimeout)
	openai, err := newOpenAIProxy(cfg.llamaURL, queue)
	if err != nil {
		log.Fatalf("LLAMA_URL: %v", err)
	}

	s := &server{
		chat:       chat,
		embeddings: embeddings,
		cache:      cache,
		queue:      queue,
		openai:     openai,
	}
	srv := &http.Server{
		Addr:              cfg.addr,
		Handler:           instrument(s.routes()),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(
		context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("listening on %s, chat worker %s, embed worker %s",
			cfg.addr, cfg.llamaURL, cfg.embedURL)
		err := srv.ListenAndServe()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(
		context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}
