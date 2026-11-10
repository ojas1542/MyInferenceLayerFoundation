package main

import (
	"encoding/json"
	"strings"
)

// isConnectionTool reports whether a tool belongs to one of the agent's
// connections. eve names those <connection>__<tool>, for example
// gmail__search_threads, and no built-in or authored tool has "__".
func isConnectionTool(tool json.RawMessage) bool {
	var t struct {
		Function struct {
			Name string `json:"name"`
		} `json:"function"`
	}
	return json.Unmarshal(tool, &t) == nil &&
		strings.Contains(t.Function.Name, "__")
}

// connectionToolsLast moves connection tools to the end of a chat
// completions request's tool list, keeping the order within each group.
// It reports false, and returns body as is, when nothing moves.
//
// The agent adds a connection's tools only once the model finds them with
// connection_search, and eve inserts them in the middle of its list. The
// chat template renders tools before the system prompt, and the model is
// hybrid recurrent, so llama-server can only resume a changed prompt from
// a context checkpoint before the change. With the new tools in the
// middle there is none, and the next step re-reads the whole prompt.
// With them last, the prompt changes right after the agent's own tools,
// where the warm-up leaves a checkpoint (see prefixWarmer).
func connectionToolsLast(body []byte) ([]byte, bool) {
	var req map[string]json.RawMessage
	if json.Unmarshal(body, &req) != nil {
		return body, false
	}
	var tools []json.RawMessage
	if json.Unmarshal(req["tools"], &tools) != nil {
		return body, false
	}
	var own, conn []json.RawMessage
	moved := false
	for _, tool := range tools {
		if isConnectionTool(tool) {
			conn = append(conn, tool)
			continue
		}
		moved = moved || len(conn) > 0
		own = append(own, tool)
	}
	if !moved {
		return body, false
	}
	ordered, err := json.Marshal(append(own, conn...))
	if err != nil {
		return body, false
	}
	req["tools"] = ordered
	out, err := json.Marshal(req)
	if err != nil {
		return body, false
	}
	return out, true
}
