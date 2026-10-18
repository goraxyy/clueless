#!/usr/bin/env bash
# Start Clueless on macOS or Linux with one command:   ./start.sh
# It checks Node, installs what's needed, asks for your Claude key the first time (and saves it in
# app/.env, which is never committed), then runs the app. ./start.sh --setup does everything but run it.
set -euo pipefail

cd "$(dirname "$0")/app"
say() { printf '\033[1;38;5;173m›\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- Node 22.12 or newer ----------
node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)'
}
if ! node_ok; then
  if command -v node >/dev/null 2>&1; then say "Node $(node -v) is too old: Clueless needs 22.12 or newer."; else say "Node.js isn't installed."; fi
  if command -v brew >/dev/null 2>&1; then
    read -r -p "Install the latest Node with Homebrew now? [Y/n] " yes
    if [[ ! "$yes" =~ ^[Nn] ]]; then
      brew install node || brew upgrade node
      hash -r
    fi
  fi
  node_ok || fail "Install Node.js 22.12 or newer from https://nodejs.org (the LTS download), open a new terminal, and run ./start.sh again."
fi
say "Node $(node -v)"

# ---------- packages ----------
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  say "Installing packages (the first time takes a minute or two)…"
  npm install --no-audit --no-fund || fail "npm install failed. On a Mac, run  xcode-select --install  and then ./start.sh again."
fi

# ---------- a way to reach Claude ----------
[ -f .env ] || cp .env.example .env
has_key() { grep -Eq '^[[:space:]]*(ANTHROPIC_API_KEY|AWS_BEARER_TOKEN_BEDROCK|AWS_PROFILE|AWS_ACCESS_KEY_ID)[[:space:]]*=[[:space:]]*[^[:space:]#]' .env; }
if ! has_key && [ -z "${ANTHROPIC_API_KEY:-}${AWS_BEARER_TOKEN_BEDROCK:-}" ]; then
  say "Clueless needs a way to reach Claude. Which key do you have?"
  echo "  1) A Claude API key (from console.anthropic.com, starts with sk-ant-)"
  echo "  2) An Amazon Bedrock API key"
  read -r -p "1 or 2: " which
  case "$which" in
    2) name=AWS_BEARER_TOKEN_BEDROCK ;;
    *) name=ANTHROPIC_API_KEY ;;
  esac
  read -r -s -p "Paste the key (it won't show) and press Enter: " key
  echo
  [ -n "$key" ] || fail "No key given. Run ./start.sh again when you have one."
  # Node writes it, so no character in the key can break the file.
  KEY_NAME="$name" KEY_VALUE="$key" node -e '
    const fs = require("fs")
    const { KEY_NAME: name, KEY_VALUE: value } = process.env
    const lines = fs.readFileSync(".env", "utf8").split("\n")
    const at = lines.findIndex((l) => new RegExp(`^\\s*#?\\s*${name}\\s*=`).test(l))
    if (at >= 0) lines[at] = `${name}=${value.trim()}`
    else lines.push(`${name}=${value.trim()}`)
    fs.writeFileSync(".env", lines.join("\n"))
  '
  say "Saved in app/.env"
fi

[ "${1:-}" = "--setup" ] && { say "All set. Run ./start.sh to start Clueless."; exit 0; }

# ---------- run ----------
say "Starting Clueless…"
if [ "$(uname)" = "Darwin" ]; then
  say "It lives in the menu bar (no Dock icon). Cmd+Shift+Space reads your screen, Cmd+Shift+3 shows the island."
  say "First time: allow Screen Recording, Microphone and Accessibility for your terminal app (or Electron) in System Settings → Privacy & Security, then run ./start.sh again."
fi
exec npm run dev
