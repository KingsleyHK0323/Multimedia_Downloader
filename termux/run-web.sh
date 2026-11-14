#!/usr/bin/env bash
# Multimedia Downloader — web UI launcher for Android (Termux).
# Checks the installed dependencies and web UI, then starts the server.
#
#   bash termux/run-web.sh
#   PORT=8080 MMDL_DOWNLOADS=~/storage/downloads bash termux/run-web.sh
set -e
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"

if ! command -v python >/dev/null 2>&1; then
  echo "Python is required. See termux/README.md for explicit setup steps." >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "FFmpeg is required. See termux/README.md for explicit setup steps." >&2
  exit 1
fi
if ! python -B -c 'import importlib.util, sys; sys.exit(any(importlib.util.find_spec(m) is None for m in ("flask", "yt_dlp")))'; then
  echo "Flask and yt-dlp are required. See termux/README.md for explicit setup steps." >&2
  exit 1
fi

# Do not replace an existing directory or fetch code during normal startup.
if [ ! -f frontend/dist/index.html ]; then
  echo "The web frontend is missing. See termux/README.md for explicit setup steps." >&2
  exit 1
fi

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8080}"
export MMDL_DOWNLOADS="${MMDL_DOWNLOADS:-$HOME/storage/downloads}"
# OpenAI-Codex_web_ai: URLs need brackets around IPv6 literals.
display_host="$HOST"
case "$display_host" in
  \[*\]) ;;
  *:*) display_host="[$display_host]" ;;
esac
echo "──────────────────────────────────────────────"
echo " Open  http://$display_host:$PORT  in your phone browser"
echo " Downloads → $MMDL_DOWNLOADS"
echo "──────────────────────────────────────────────"
exec python web_app.py

# Updated by: OpenAI-Codex_Fork_Source_Code
