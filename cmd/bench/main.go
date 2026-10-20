// Command bench replays a prompt set against POST /v1/generate and
// reports how fast cached answers come back compared with generated
// ones, the cache hit rate, and how many hits were wrong: answered with
// a different question's cached answer.
//
// Run it against an empty cache, e.g. after
// docker compose exec redis redis-cli FLUSHALL:
//
//	go run ./cmd/bench -concurrency 1
package main

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
)

//go:embed prompts.txt
var defaultPrompts string

// request is one prompt of the replay and the question it asks.
type request struct {
	question int
	prompt   string
}

type result struct {
	request
	status     int
	cached     bool
	similarity float64
	text       string
	ttft       time.Duration
	total      time.Duration
	err        error
}

func main() {
	url := flag.String("url", "http://127.0.0.1:9000", "inference layer")
	file := flag.String("prompts", "", "prompt set (default: built in)")
	concurrency := flag.Int("concurrency", 1, "requests in flight")
	seed := flag.Uint64("seed", 1, "seed for the replay order")
	flag.Parse()

	text := defaultPrompts
	if *file != "" {
		b, err := os.ReadFile(*file)
		if err != nil {
			log.Fatal(err)
		}
		text = string(b)
	}
	questions := parsePrompts(text)
	reqs := replay(questions, *seed)
	log.Printf("replaying %d prompts for %d questions, %d at a time",
		len(reqs), len(questions), *concurrency)

	results := run(*url, reqs, *concurrency)
	report(os.Stdout, results)
}

// parsePrompts splits a prompt set into questions, each a list of ways
// to ask it.
func parsePrompts(text string) [][]string {
	var questions [][]string
	var cur []string
	sc := bufio.NewScanner(strings.NewReader(text + "\n\n"))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		switch {
		case strings.HasPrefix(line, "#"):
		case line == "":
			if len(cur) > 0 {
				questions = append(questions, cur)
				cur = nil
			}
		default:
			cur = append(cur, line)
		}
	}
	return questions
}

// replay asks each question first as written, then again verbatim and
// then in each other wording. The questions are interleaved in a seeded
// random order, keeping each question's own order, so a question's
// repeats arrive among other traffic.
func replay(questions [][]string, seed uint64) []request {
	queues := make([][]request, len(questions))
	for i, q := range questions {
		queues[i] = append(queues[i], request{i, q[0]}, request{i, q[0]})
		for _, p := range q[1:] {
			queues[i] = append(queues[i], request{i, p})
		}
	}
	rng := rand.New(rand.NewPCG(seed, seed))
	var out []request
	for len(queues) > 0 {
		i := rng.IntN(len(queues))
		out = append(out, queues[i][0])
		if queues[i] = queues[i][1:]; len(queues[i]) == 0 {
			queues = slices.Delete(queues, i, i+1)
		}
	}
	return out
}

func run(url string, reqs []request, concurrency int) []result {
	results := make([]result, len(reqs))
	next := make(chan int)
	var wg sync.WaitGroup
	for range concurrency {
		wg.Go(func() {
			for i := range next {
				results[i] = send(url, reqs[i])
				r := results[i]
				log.Printf("%3d/%d q%-2d %-6s %7.3fs  %s", i+1, len(reqs),
					r.question, outcome(r), r.total.Seconds(), r.prompt)
			}
		})
	}
	for i := range reqs {
		next <- i
	}
	close(next)
	wg.Wait()
	return results
}

func outcome(r result) string {
	switch {
	case r.err != nil:
		return "error"
	case r.status != http.StatusOK:
		return fmt.Sprint(r.status)
	case r.cached:
		return "hit"
	default:
		return "miss"
	}
}

// send streams one generation, timing the first token and the whole
// answer.
func send(url string, req request) result {
	res := result{request: req}
	body, _ := json.Marshal(map[string]any{
		"prompt": req.prompt, "stream": true,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	hr, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		url+"/v1/generate", bytes.NewReader(body))
	hr.Header.Set("Content-Type", "application/json")
	start := time.Now()
	resp, err := http.DefaultClient.Do(hr)
	if err != nil {
		res.err = err
		return res
	}
	defer resp.Body.Close()
	res.status = resp.StatusCode
	if resp.StatusCode != http.StatusOK {
		res.total = time.Since(start)
		return res
	}

	var text strings.Builder
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		data, ok := strings.CutPrefix(sc.Text(), "data: ")
		if !ok {
			continue
		}
		var ev struct {
			Text       string  `json:"text"`
			Reasoning  string  `json:"reasoning"`
			Done       bool    `json:"done"`
			Cached     bool    `json:"cached"`
			Similarity float64 `json:"similarity"`
			Error      string  `json:"error"`
		}
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			res.err = err
			return res
		}
		if res.ttft == 0 && (ev.Text != "" || ev.Reasoning != "") {
			res.ttft = time.Since(start)
		}
		text.WriteString(ev.Text)
		switch {
		case ev.Error != "":
			res.err = errors.New(ev.Error)
			return res
		case ev.Done:
			res.total = time.Since(start)
			res.cached, res.similarity = ev.Cached, ev.Similarity
			res.text = text.String()
			return res
		}
	}
	res.err = errors.New("stream ended early")
	if sc.Err() != nil {
		res.err = sc.Err()
	}
	return res
}
