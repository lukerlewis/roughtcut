#!/usr/bin/env bash
# Makes a 2-minute 4K test video in your home folder:  bash spikes/playback/make-test-video.sh
# Like a camera file: 3840x2160, 30fps, HEVC, a keyframe every 2 seconds (the hard case for scrubbing).
set -euo pipefail
for d in /opt/homebrew/bin /usr/local/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
out="$HOME/roughcut 4K test.mp4"
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q hevc_videotoolbox; then
  enc=(-c:v hevc_videotoolbox -b:v 45M -tag:v hvc1)
else
  enc=(-c:v libx265 -preset ultrafast -b:v 45M -tag:v hvc1)
fi
ffmpeg -hide_banner -loglevel error -stats -y \
  -f lavfi -i "testsrc2=size=3840x2160:rate=30,format=yuv420p" \
  -f lavfi -i "sine=frequency=220:sample_rate=48000" \
  -t 120 "${enc[@]}" -g 60 -c:a aac -b:a 128k -shortest "$out"
echo
echo "Made: $out"
