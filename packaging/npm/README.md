# Multimedia Downloader web package

<!-- OpenAI-Codex: describe this package and its runtime requirements. -->

This package contains the Multimedia Downloader web application. It requires
Node.js 22 or newer, Python 3.10 or newer, and FFmpeg available on PATH. The
Python runtime dependencies are listed in the packaged
`app/requirements-web.txt`; npm does not install Python or FFmpeg.

Configure the `@kingsleyhk0323` scope to use
[GitHub Packages](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
and authenticate with a token that can read the package. Package visibility is
controlled by its owner.

```sh
npm install @kingsleyhk0323/multimedia-downloader@dev
python3 -m pip install -r node_modules/@kingsleyhk0323/multimedia-downloader/app/requirements-web.txt
npx multimedia-downloader-web
```

Open http://127.0.0.1:5000. On Windows use `python` in place of `python3`.
Set `MMDL_PYTHON` to select another Python executable, `MMDL_DOWNLOADS` to
choose the download directory, or `PORT` to change the listening port.
The default download directory is `downloads` in the working directory.

The app has no authentication. Keep it bound to localhost unless a separate
access-control layer is provided. Development packages use a `-dev` version
and the `dev` distribution tag. Stable packages use their release version.

The original project code is licensed under the PolyForm Noncommercial
License 1.0.0. See `LICENSE` and `THIRD-PARTY-NOTICES.md` for details.
