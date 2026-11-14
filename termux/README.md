# Running on Android via Termux

The desktop app is a native binary and does **not** run on Android — but the
engine underneath it is pure Python (yt-dlp + ffmpeg), and both are available
in [Termux](https://termux.dev). So you can run Multimedia Downloader on your
phone from a terminal, either as a **CLI** or as the **web UI** in your browser.

> Install Termux from **F-Droid** or **GitHub**, not the Play Store (that build
> is outdated). Optional but recommended: `termux-setup-storage` (grants access
> to `~/storage/downloads` so files land in your normal Downloads folder).

## One-time: get the code

```bash
pkg install -y git
git clone https://github.com/KingsleyHK0323/Multimedia_Downloader.git
cd Multimedia_Downloader
```

## One-time: install dependencies explicitly

The launchers only check dependencies; they do not install or upgrade them.
On Termux, perform a full package upgrade before installing packages to avoid
an unsupported partial upgrade:

```bash
pkg upgrade
pkg install python ffmpeg
python -m pip install -r engine/requirements.txt  # CLI
python -m pip install -r requirements-web.txt     # Web UI, if needed
```

For the Web UI, build the frontend separately with
`npm run build:frontend:web`, or obtain and inspect the official
`frontend-dist.zip` release asset and extract it without overwriting existing
files. The launcher expects `frontend/dist/index.html`.

## Option A — CLI (lightest)

```bash
bash termux/run-cli.sh download "https://youtu.be/XXXX" -o ~/storage/downloads -f mp4 -q 720p
bash termux/run-cli.sh download "https://..." --audio --audio-format mp3
bash termux/run-cli.sh convert clip.mkv -o ~/storage/downloads -f mp4
bash termux/run-cli.sh formats
```

The script checks `python`, `ffmpeg`, and `yt-dlp`, then calls
[`cli.py`](../cli.py). You can also run `python cli.py --help` directly once the
dependencies are installed. Add `--lang zh_tw` (or `zh_cn`) for localized messages.

## Option B — Web UI in your browser

```bash
bash termux/run-web.sh
# then open the printed URL, e.g. http://127.0.0.1:8080, in your phone browser
```

This checks the installed dependencies and frontend, then starts the same
Flask and SSE server the desktop web version uses. Downloaded
files go to `MMDL_DOWNLOADS` (default `~/storage/downloads`). Override with:

```bash
PORT=8080 MMDL_DOWNLOADS=~/storage/downloads bash termux/run-web.sh
```

To reach it from another device on your LAN, bind to `0.0.0.0` and set
`MMDL_TRUSTED_HOSTS` to the server address used by clients. The list replaces
the loopback defaults. Use trusted networks: there is no built-in authentication.

```bash
HOST=0.0.0.0 MMDL_TRUSTED_HOSTS='localhost,127.0.0.1,192.168.1.10' bash termux/run-web.sh
```
<!-- OpenAI-Codex_Fork_GitHub_REPO -->

## Notes

- **Upgrade before installing** — Termux does not support partial upgrades. Run
  `pkg upgrade` explicitly before installing packages; the launchers never run
  package upgrades, dependency installation, or downloads automatically.
- **ffmpeg** comes from Termux's own package, so conversions and audio
  extraction work natively (arm64).
- The **AI Assistant** works here too if you set an OpenRouter API key in the
  web UI's settings.
- Keeping the download alive: Termux may sleep in the background — acquire a
  wake lock (Termux notification → "Acquire wakelock") for long batches.

### Troubleshooting: `ffmpeg` failed to install / link

If you already hit the `CANNOT LINK EXECUTABLE .../ffmpeg` error (ffmpeg left
half-configured), repair it by completing the full upgrade, then reconfigure:

```bash
pkg upgrade -y            # brings libc++ and everything else up to date
apt --fix-broken install  # finishes configuring ffmpeg
ffmpeg -version           # should now print a version
```

Then re-run `bash termux/run-web.sh` (or `run-cli.sh`).

---

## 在 Android（Termux）上使用（中文速覽）

桌面 app 無法在 Android 執行，但底層引擎是純 Python（yt-dlp + ffmpeg），在
Termux 上可用。從 **F-Droid** 安裝 Termux（非 Play 商店版），建議先跑
`termux-setup-storage`。

```bash
pkg install -y git
git clone https://github.com/KingsleyHK0323/Multimedia_Downloader.git
cd Multimedia_Downloader

# A. 終端機 CLI
bash termux/run-cli.sh download "https://youtu.be/XXXX" -o ~/storage/downloads -f mp4
bash termux/run-cli.sh --help    # 或 python cli.py --help（加 --lang zh_tw 顯示中文訊息）

# B. 手機瀏覽器用 Web 版
bash termux/run-web.sh           # 開啟顯示的網址（如 http://127.0.0.1:8080）
```

檔案預設存到 `~/storage/downloads`。長時間批次下載時，於 Termux 通知列
「Acquire wakelock」避免系統休眠中斷。

> **Termux package updates:** The launchers do not upgrade packages. If FFmpeg
> fails to link, follow the explicit troubleshooting steps above.

<!-- Updated by: OpenAI-Codex_Fork_Source_Code -->
