# Running on Android via Termux

The desktop app is a native binary and does **not** run on Android — but the
engine underneath it is pure Python (yt-dlp + ffmpeg), and both are available
in [Termux](https://termux.dev). So you can run Multimedia Downloader on your
phone from a terminal, either as a **CLI** or as the **web UI** in your browser.

<!-- OpenAI-Codex_engine_cli: revision-specific setup corrections. -->
> **Clarification:** The engine and yt-dlp use Python; FFmpeg is a separate
> executable. Available formats and codecs depend on the installed FFmpeg build.

> Install Termux from **F-Droid** or **GitHub**, not the Play Store (that build
> is outdated). Optional but recommended: `termux-setup-storage` (grants access
> to `~/storage/downloads` so files land in your normal Downloads folder).

> Distribution availability and package versions can change. Check the
> provider before installing; the store-version claim above was not checked
> against a current release in this review.

## One-time: get the code

> **Order correction:** Review and run the full `pkg upgrade` before the first
> `pkg install`, including the Git installation below. These commands change
> the device's installed packages; the launchers do not run them automatically.

```bash
pkg install -y git
git clone https://github.com/KingsleyHK0323/Multimedia_Downloader.git
cd Multimedia_Downloader
```

> A plain clone uses the repository default branch; it does not select a
> particular release. Verify the checked-out revision and use a frontend built
> from the same revision. Published releases may differ from this source tree.

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

The launchers check whether the Python modules and FFmpeg command can be found.
They do not verify package versions, module importability, FFmpeg linking, or
frontend compatibility. A later operation can still fail.

For the Web UI, build the frontend separately with
`npm run build:frontend:web`, or obtain and inspect the official
`frontend-dist.zip` release asset and extract it without overwriting existing
files. The launcher expects `frontend/dist/index.html`.

> **Asset correction:** This source tree's release workflow selects installer
> files for upload and does not select `frontend-dist.zip`. An older project
> record mentions that archive, but its availability for a particular release
> was not verified here. Inspect the official release and match the frontend
> to the source revision. The launcher checks only for `index.html`; it does
> not download, inspect, or verify the frontend.

Building the frontend also requires Node.js, npm, and the locked frontend
dependencies. In a fresh, separate checkout with no existing
`frontend/node_modules` or `frontend/dist` to preserve, the following commands
install the frontend dependencies and build the web frontend:

```bash
npm ci --prefix frontend
npm run build:frontend:web
```

`npm ci` replaces an existing `frontend/node_modules`, and the build may replace
`frontend/dist`; do not run them where those files must be preserved. Native npm
packages and the frontend build on Termux have not been verified for this tree.

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

Place the global `--lang` option before the subcommand, for example
`bash termux/run-cli.sh --lang zh_tw download URL`. It selects application
messages; the command-line help text remains English. The launcher requires
FFmpeg on `PATH` even for `--help` and `formats`.

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

This default belongs to `run-web.sh`; running `web_app.py` directly uses its
own configured default. In this working tree, browser-file upload is unavailable
on Termux, so conversion inputs must already be accessible on the server.
By default, Web input and output paths are confined to the downloads root.
The server's explicit absolute-path opt-out broadens that access.

To reach it from another device on your LAN, bind to `0.0.0.0` and explicitly
allow the address that device will use. Replace `192.168.1.10` below with the
server's address. The configured list replaces the loopback-only default.

```bash
HOST=0.0.0.0 MMDL_TRUSTED_HOSTS='localhost,127.0.0.1,192.168.1.10' bash termux/run-web.sh
```

Use only networks you trust: the server has no built-in authentication.

## Notes

- **Upgrade before installing** — Termux does not support partial upgrades. Run
  `pkg upgrade` explicitly before installing packages; the launchers never run
  package upgrades, dependency installation, or downloads automatically.
- **ffmpeg** comes from Termux's own package, so conversions and audio
  extraction work natively (arm64).
- The **AI Assistant** works here too if you set an OpenRouter API key in the
  web UI's settings.

  AI use additionally depends on a working network, service, valid credentials,
  and the behavior of the selected source revision; it has not been verified
  for this checkout on an Android device.
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

> <!--
> **Quick-start prerequisite:** Follow the upgrade and dependency setup above, as applicable,
> before installing Git or starting the launchers in the commands below.
> -->
> **Quick-start prerequisite:** Sequence: upgrade first, install Git and clone, then install the Python
> dependencies and prepare the Web frontend before starting a launcher.
> FFmpeg is a separate executable, not a Python package.

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

> **CLI default correction:** Without `-o` / `--output`, CLI download and
> conversion use the current directory from which `run-cli.sh` was invoked.
> The `~/storage/downloads` default above applies to `run-web.sh` when
> `MMDL_DOWNLOADS` is unset; it is not the CLI default. Follow the dependency
> and frontend setup above before using the quick-start commands. Earlier
> Android reports concern older revisions and do not establish that this
> checkout has been tested on a device.

> **Termux package updates:** The launchers do not upgrade packages. If FFmpeg
> fails to link, follow the explicit troubleshooting steps above.

<!-- Updated by: OpenAI-Codex_Fork_Source_Code -->
