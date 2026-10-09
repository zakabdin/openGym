#!/bin/sh
# Sharpen the exercise pictures once, after they are downloaded.
#
# The dataset ships every GIF and still at 180x180 pixels, and the app shows them in a box of
# 320 CSS pixels or more: on a phone that is a 4-5x stretch by the browser's own smoothing, which
# is what makes them look soft. Scaling them up here with Lanczos and a light sharpen gives the
# browser a bigger, crisper picture to start from. It adds no detail the source does not have.
#
#   upscale-media <dir that holds img/ and gif/>
#
# MEDIA_UPSCALE_PX is the target side in pixels: 270 by default, 360 for more sharpness (and
# roughly twice the bytes), 0 to leave the pictures as downloaded. Only files narrower than the
# target are touched, so running it again (every `docker compose up`) finds nothing to do, and a
# file is replaced only once its new version is complete — a stop in the middle leaves every
# picture either old or new, never half-written.
set -eu

if [ "${1:-}" = "--one" ]; then
  f="$2"; px="${MEDIA_UPSCALE_PX:-270}"
  w=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$f" 2>/dev/null | head -n 1) || exit 0
  [ -n "$w" ] && [ "$w" -lt "$px" ] || exit 0
  tmp="$f.tmp.${f##*.}"
  trap 'rm -f "$tmp"' EXIT
  sharpen="scale=$px:$px:flags=lanczos,unsharp=5:5:0.8:5:5:0.0"
  case "$f" in
    *.gif) ffmpeg -loglevel error -y -i "$f" -vf "$sharpen,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" "$tmp" ;;
    *.jpg) ffmpeg -loglevel error -y -i "$f" -vf "$sharpen" -q:v 3 "$tmp" ;;
    *) exit 0 ;;
  esac
  mv "$tmp" "$f"
  exit 0
fi

dir="${1:?usage: upscale-media <dir>}"
px="${MEDIA_UPSCALE_PX:-270}"
case "$px" in ''|*[!0-9]*) echo "MEDIA_UPSCALE_PX must be a number, got '$px'" >&2; exit 1 ;; esac
if [ "$px" -eq 0 ]; then echo "  Picture sharpening is off (MEDIA_UPSCALE_PX=0)."; exit 0; fi

export MEDIA_UPSCALE_PX="$px"
# Leftovers of a run that was stopped mid-file.
find "$dir" -name '*.tmp.*' -delete
echo "  Sharpening exercise pictures to ${px}px (one time, a few minutes)…"
find "$dir" \( -name '*.gif' -o -name '*.jpg' \) -print0 \
  | xargs -0 -n 1 -P "$(nproc)" sh "$0" --one
echo "✓ Exercise pictures are ${px}px."
