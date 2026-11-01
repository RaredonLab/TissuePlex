#!/bin/bash
# Re-export the README demo animation from a screen recording.
#
#   docs/make_demo_gif.sh [recording.mov] [width] [speed]
#
# Defaults reproduce docs/demo_1080p.gif and docs/demo_1080p.mp4: the
# recording played at 6x (about 3 min -> 30 s), 1920 px wide, 16:9.
# docs/demo.gif (the README one) is the same cut at 800 px / 8 fps, kept
# small so GitHub renders it inline.
#
# The 4K source is decoded once into a 30 fps H.264 intermediate (also kept,
# as the .mp4 — PowerPoint plays it far better than a GIF); the GIF is then
# derived from that with a two-pass palette.
#
# Needs ffmpeg with libx264. Set FFMPEG to use a binary that is not on PATH,
# e.g. the static build from `pip install imageio-ffmpeg`
# (`python -c 'import imageio_ffmpeg as f; print(f.get_ffmpeg_exe())'`).
set -euo pipefail
SRC="${1:-recording.mov}"
W="${2:-1920}"
SPEED="${3:-6}"
FFMPEG="${FFMPEG:-ffmpeg}"
H=$(( W * 9 / 16 ))
OUT="$(dirname "$0")"
MP4="$OUT/demo_${H}p.mp4"
GIF="$OUT/demo_${H}p.gif"

"$FFMPEG" -y -hide_banner -loglevel error -stats \
  -i "$SRC" -an \
  -vf "setpts=PTS/${SPEED},fps=30,scale=${W}:${H}:flags=lanczos" \
  -c:v libx264 -preset fast -crf 14 -pix_fmt yuv420p \
  "$MP4"

"$FFMPEG" -y -hide_banner -loglevel error -stats \
  -i "$MP4" \
  -vf "fps=10,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop 0 "$GIF"

ls -la "$MP4" "$GIF"
