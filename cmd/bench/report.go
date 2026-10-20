package main

import (
	"fmt"
	"io"
	"slices"
	"text/tabwriter"
	"time"
)

func report(out io.Writer, results []result) {
	// Which question each generated answer belongs to, to tell whether
	// a cache hit returned the answer to the question that was asked.
	owner := make(map[string]int)
	var hits, misses []result
	var exact, wrong, rejected, failed int
	for _, r := range results {
		switch {
		case r.err != nil:
			failed++
		case r.status != 200:
			rejected++
		case r.cached:
			hits = append(hits, r)
		default:
			misses = append(misses, r)
			owner[r.text] = r.question
		}
	}
	for _, r := range hits {
		if r.similarity == 1 {
			exact++
		}
		if q, ok := owner[r.text]; !ok || q != r.question {
			wrong++
		}
	}

	w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	answered := len(hits) + len(misses)
	fmt.Fprintf(w, "\nRequests\t%d\t(%d answered, %d rejected, %d failed)\n",
		len(results), answered, rejected, failed)
	if answered > 0 {
		fmt.Fprintf(w, "Hit rate\t%.1f%%\t(%d exact, %d semantic, %d misses)\n",
			100*float64(len(hits))/float64(answered),
			exact, len(hits)-exact, len(misses))
	}
	fmt.Fprintf(w, "Wrong hits\t%d\t(another question's answer)\n", wrong)
	fmt.Fprintln(w)
	fmt.Fprintln(w, "\tp50\tp95\tmean")
	row := func(name string, rs []result, d func(result) time.Duration) {
		if len(rs) == 0 {
			return
		}
		p50, p95, mean := stats(rs, d)
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", name, ms(p50), ms(p95), ms(mean))
	}
	ttft := func(r result) time.Duration { return r.ttft }
	total := func(r result) time.Duration { return r.total }
	row("Cache hit, first token", hits, ttft)
	row("Cache hit, full answer", hits, total)
	row("Generated, first token", misses, ttft)
	row("Generated, full answer", misses, total)
	if len(hits) > 0 && len(misses) > 0 {
		h, _, _ := stats(hits, total)
		m, _, _ := stats(misses, total)
		fmt.Fprintf(w, "\nFull answer p50 speedup\t%.0fx\n",
			float64(m)/float64(h))
	}
	w.Flush()
}

// stats returns the median, 95th percentile (nearest rank) and mean of
// d over rs.
func stats(rs []result, d func(result) time.Duration) (
	p50, p95, mean time.Duration,
) {
	ds := make([]time.Duration, len(rs))
	var sum time.Duration
	for i, r := range rs {
		ds[i] = d(r)
		sum += ds[i]
	}
	slices.Sort(ds)
	rank := func(p float64) time.Duration {
		i := int(p*float64(len(ds))+0.5) - 1
		return ds[max(0, min(i, len(ds)-1))]
	}
	return rank(0.5), rank(0.95), sum / time.Duration(len(ds))
}

func ms(d time.Duration) string {
	if d >= 10*time.Second {
		return fmt.Sprintf("%.1f s", d.Seconds())
	}
	return fmt.Sprintf("%.1f ms", float64(d)/float64(time.Millisecond))
}
