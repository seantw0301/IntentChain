#!/usr/bin/env bash
# Joins the 30-second opening to the recorded demo.
#
#   scripts/assemble-video.sh <opening.mp4> <demo.mp4> <skip-seconds> <output.mp4> [speed]
#
# <skip-seconds> is how much of the start of the demo recording to drop (its own
# title cards). [speed] slightly speeds up the demo part only, to keep the
# total under three minutes; narration pitch is preserved. Default 1.0.
set -euo pipefail
INTRO="$1"; MAIN="$2"; SKIP="$3"; OUT="$4"; SPEED="${5:-1.0}"

INTRO_LEN=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$INTRO")
FADE_AT=$(echo "$INTRO_LEN - 0.35" | bc -l)

ffmpeg -y -loglevel error -i "$INTRO" -i "$MAIN" -filter_complex "
  [0:v]scale=1920:1080,fps=30,format=yuv420p,fade=t=out:st=${FADE_AT}:d=0.35[v0];
  [0:a]aresample=44100,aformat=channel_layouts=stereo[a0];
  [1:v]trim=start=${SKIP},setpts=(PTS-STARTPTS)/${SPEED},scale=1920:1080,fps=30,format=yuv420p,fade=t=in:st=0:d=0.35[v1];
  [1:a]atrim=start=${SKIP},asetpts=PTS-STARTPTS,atempo=${SPEED},aresample=44100,aformat=channel_layouts=stereo[a1];
  [v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart "$OUT"

LEN=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")
printf 'Wrote %s — %d:%02d\n' "$OUT" "$(echo "$LEN/60" | bc)" "$(echo "$LEN%60/1" | bc)"
