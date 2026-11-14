# Security Policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 4.1.x   | :white_check_mark: |
| 4.0.x   | :white_check_mark: |
| < 4.0   | :x:                |

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately via GitHub's
[**Report a vulnerability**](https://github.com/KingsleyHK0323/Multimedia_Downloader/security/advisories/new)
button (Security → Advisories). We'll acknowledge within a few days and keep you
posted on the fix.

## Scope notes

- The **AI Assistant** sends prompts to [OpenRouter](https://openrouter.ai)
  using your API key. The interface can optionally save the key in browser or app
  WebView localStorage, not an OS keychain. An unsaved key lasts while the panel
  remains open; disabling saving does not remove a previously stored key. In Web
  mode the key also passes through the application server. File-touching actions
  require confirmation.
  <!-- OpenAI-Codex_Fork_GitHub_REPO -->
- The **web version** (`web_app.py`) defaults to loopback hosts and checks
  browser origins and JSON command bodies. These checks are not authentication;
  requests without an Origin header are permitted. Do not expose it to an
  untrusted network without your own authentication. Explicitly configure trusted
  hosts/origins and proxy Host/scheme forwarding for LAN or reverse proxies.
  <!-- OpenAI-Codex_Fork_GitHub_REPO -->
- The bundled `ffmpeg` is a third-party binary (GPLv3); see
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

<!-- Updated by: OpenAI-Codex -->
