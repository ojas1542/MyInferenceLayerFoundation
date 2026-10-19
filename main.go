// Command inferencelayer is a minimal HTTP API in front of llama.cpp
// llama-server workers, with a semantic response cache.
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
}

func loadConfig() (config, error) {
	cfg := config{
		addr:     envOr("ADDR", ":9000"),
		llamaURL: envOr("LLAMA_URL", "http://127.0.0.1:8080"),
		embedURL: envOr("EMBED_URL", "http://127.0.0.1:8081"),
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
	return cfg, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	client := &http.Client{}
	chat := &worker{baseURL: cfg.llamaURL, client: client}
	embeddings := &worker{baseURL: cfg.embedURL, client: client}
	cache, err := newResponseCache(
		embeddings, cfg.cacheSize, cfg.cacheThreshold)
	if err != nil {
		log.Fatalf("cache: %v", err)
	}
	defer cache.close()
	openai, err := newOpenAIProxy(cfg.llamaURL)
	if err != nil {
		log.Fatalf("LLAMA_URL: %v", err)
	}

	s := &server{
		chat:       chat,
		embeddings: embeddings,
		cache:      cache,
		openai:     openai,
	}
	srv := &http.Server{
		Addr:              cfg.addr,
		Handler:           s.routes(),
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
