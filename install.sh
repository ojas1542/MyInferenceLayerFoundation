#!/bin/bash
# Installs everything the personal agent stack needs on a Mac with Apple
# silicon: Homebrew packages, Docker, the models, a .env with fresh secrets,
# and the JavaScript and Go dependencies. Safe to run again; finished steps
# are skipped. Start the stack afterwards with ./run.sh.
set -euo pipefail

# Under Rosetta, Homebrew and llama.cpp would run as x86_64, so re-run
# natively.
if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
  exec arch -arm64 /bin/bash "$0" "$@"
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
AGENT="$ROOT/personal-agent"
BREW=/opt/homebrew/bin/brew

HF=https://huggingface.co
CHAT_MODEL_URL="$HF/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf"
EMBED_MODEL_URL="$HF/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/\
Qwen3-Embedding-0.6B-Q8_0.gguf"

step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" != 1 ]; then
  fail "this script supports macOS on Apple silicon only"
fi

step "Homebrew"
if [ ! -x "$BREW" ]; then
  /bin/bash -c "$(curl -fsSL \
    https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$("$BREW" shellenv)"
"$BREW" --version | sed -n 1p

step "Go, Node 24 and llama.cpp"
# node@24 rather than node: Node 25 and later no longer ship corepack, which
# pins pnpm to the version in personal-agent/package.json.
# Only missing formulae: brew install would also upgrade installed ones.
for formula in go node@24 llama.cpp; do
  "$BREW" list --formula "$formula" >/dev/null 2>&1 ||
    "$BREW" install "$formula"
done
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
echo "$(go env GOVERSION), node $(node -v), llama.cpp $(
  llama-server --version 2>&1 | sed -n 's/^version: //p')"

step "Docker"
if ! command -v docker >/dev/null; then
  "$BREW" install --cask docker-desktop
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Open Docker Desktop once and"
  echo "accept its terms; ./run.sh needs it for Postgres and Redis."
else
  docker --version
fi

step "Models"
download() {
  local file
  file="$ROOT/$(basename "$1")"
  if [ -f "$file" ] && [ ! -f "$file.part" ]; then
    echo "$(basename "$file") is already downloaded"
    return
  fi
  # Download to .part and resume it if interrupted, so a half-written file
  # is never mistaken for a finished one.
  touch "$file.part"
  curl -fL --retry 3 --continue-at - -o "$file.part" "$1"
  mv "$file.part" "$file"
}
download "$CHAT_MODEL_URL"
download "$EMBED_MODEL_URL"

step "personal-agent/.env"
if [ -f "$AGENT/.env" ]; then
  echo ".env already exists, leaving it as is"
else
  auth_secret="$(openssl rand -hex 32)"
  internal_secret="$(openssl rand -hex 32)"
  sed \
    -e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$auth_secret|" \
    -e "s|^INTERNAL_API_SECRET=.*|INTERNAL_API_SECRET=$internal_secret|" \
    "$AGENT/.env.example" > "$AGENT/.env"
  chmod 600 "$AGENT/.env"
  echo "Created .env with new secrets. Optional keys (web search, iMessage,"
  echo "Gmail) are listed in personal-agent/docs/ENVIRONMENT.md."
fi

step "JavaScript dependencies"
(cd "$AGENT" && corepack pnpm install --frozen-lockfile)
(cd "$ROOT/gmail-mcp" && npm ci)
(cd "$ROOT/imessage-bridge" && npm ci)

step "Inference layer"
(cd "$ROOT" && go build -o bin/inferencelayer .)
echo "Built bin/inferencelayer"

step "Done"
echo "Start everything with ./run.sh"
if ! grep -q '^GOOGLE_CLIENT_ID=.' "$AGENT/.env"; then
  echo "For Gmail, see step 7 of README.md, then: cd gmail-mcp && npm run auth"
fi
