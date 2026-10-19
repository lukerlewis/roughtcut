#!/usr/bin/env bash
# Make a rough cut:  bash cut.sh /path/to/video.mov   (drag the file into Terminal to fill in its path)
set -uo pipefail
cd "$(dirname "$0")"
[ -x .venv/bin/roughcut ] || { echo "Run the setup first:  bash scripts/setup-mac.sh"; exit 1; }
[ $# -ge 1 ] || { echo "Drag a video file in after 'bash cut.sh ' and press Enter."; exit 1; }
for d in /opt/homebrew/bin "$HOME/.local/bin"; do [ -d "$d" ] && PATH="$d:$PATH"; done
out=$(.venv/bin/roughcut cut "$@") || exit 1
echo
echo "Finished. Your files are in: $out"
if [ "$(uname)" = "Darwin" ]; then
  open "$out"
  [ -f "$out/report.md" ] && open -a TextEdit "$out/report.md"
fi
