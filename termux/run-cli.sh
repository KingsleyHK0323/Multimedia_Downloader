#!/usr/bin/env bash
# Multimedia Downloader — CLI launcher for Android (Termux) or any POSIX shell.
# Checks existing dependencies, then runs cli.py with your arguments.
#
#   bash termux/run-cli.sh download "https://youtu.be/XXXX" -o ~/storage/downloads -f mp4
#   bash termux/run-cli.sh download "https://..." --audio --audio-format mp3
#   bash termux/run-cli.sh formats
set -e
here="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v python >/dev/null 2>&1; then
  echo "Python is required. See termux/README.md for explicit setup steps." >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "FFmpeg is required. See termux/README.md for explicit setup steps." >&2
  exit 1
fi
if ! python -B -c 'import importlib.util, sys; sys.exit(importlib.util.find_spec("yt_dlp") is None)'; then
  echo "yt-dlp is required. See termux/README.md for explicit setup steps." >&2
  exit 1
fi
exec python "$here/cli.py" "$@"

# Updated by OpenAI-Codex_Fork_Source_Code.
