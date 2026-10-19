#!/usr/bin/env bash
# One-time setup for Roughcut on a Mac. Safe to run again; it skips what's done.
#   bash scripts/setup-mac.sh
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*"; exit 1; }

IS_MAC=0; [ "$(uname)" = "Darwin" ] && IS_MAC=1
EXTRA=cpu; [ "$IS_MAC" = 1 ] && [ "$(uname -m)" = "arm64" ] && EXTRA=mlx

say "1/5 Homebrew (installs the other tools)"
if [ "$IS_MAC" = 1 ]; then
  if ! command -v brew >/dev/null 2>&1; then
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
  fi
  if ! command -v brew >/dev/null 2>&1; then
    echo "  Installing Homebrew. It will ask for your Mac password (typing won't show; that's normal)."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
    command -v brew >/dev/null 2>&1 || fail "Homebrew didn't install. Copy the messages above and send them to Claude."
  fi
  ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"
else
  ok "Not a Mac; skipping Homebrew"
fi

say "2/5 FFmpeg and uv (video tools and Python)"
need=()
command -v ffmpeg >/dev/null 2>&1 || need+=(ffmpeg)
command -v uv >/dev/null 2>&1 || need+=(uv)
if [ ${#need[@]} -gt 0 ]; then
  [ "$IS_MAC" = 1 ] || fail "Please install: ${need[*]}"
  brew install "${need[@]}"
fi
ok "$(ffmpeg -version | head -1 | cut -d' ' -f1-3)"
ok "uv $(uv --version | awk '{print $2}')"

say "3/5 Roughcut itself (first time takes a few minutes)"
[ -d .venv ] || uv venv -q --python 3.12 .venv
uv pip install -q --python .venv/bin/python -e ".[$EXTRA]"
ok "Installed with the $EXTRA speech engine"

say "4/5 Claude Code (uses your Claude plan, no API key)"
if ! command -v claude >/dev/null 2>&1; then
  for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do [ -x "$c" ] && export PATH="$(dirname "$c"):$PATH"; done
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "  Installing Claude Code…"
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
  command -v claude >/dev/null 2>&1 || fail "Claude Code didn't install. Copy the messages above and send them to Claude."
fi
ok "Claude Code $(claude --version 2>/dev/null | awk '{print $1}')"
if reply=$(echo "Reply with just the word ready" | claude -p --model haiku --tools "" 2>&1) && echo "$reply" | grep -qi ready; then
  ok "Logged in to your Claude plan"
else
  echo "$reply" | tail -3
  fail "Claude Code isn't logged in yet. Type: claude   (press Enter), log in with your Claude account in the browser, type /exit, then run this setup again."
fi

say "5/5 Speech model (one-time download, roughly 1.5 GB)"
if [ "$EXTRA" = mlx ]; then
  tmp=$(mktemp -d)
  ffmpeg -v error -f lavfi -i "sine=frequency=300:duration=1" -ar 16000 -ac 1 "$tmp/t.wav"
  .venv/bin/python -c "import mlx_whisper, sys; mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo='mlx-community/whisper-large-v3-turbo')" "$tmp/t.wav" >/dev/null 2>&1 \
    || fail "The speech model didn't download. Check your internet connection and run this setup again."
  rm -rf "$tmp"
  ok "Speech model ready"
else
  ok "Skipped (downloads on first use with the $EXTRA engine)"
fi

say "All set. To cut a video, type:  bash cut.sh   then a space, drag the video file into this window, and press Enter."
