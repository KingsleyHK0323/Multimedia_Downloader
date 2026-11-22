# GLib 0.18 backport

The files in this directory are from the MIT-licensed glib 0.18.5 crate published on crates.io, SHA-256 `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`. `src/variant_iter.rs` contains the two-line soundness fix from https://github.com/gtk-rs/gtk-rs-core/pull/1343, also proposed for the 0.18 branch in https://github.com/gtk-rs/gtk-rs-core/pull/2009. Other original files are unchanged.

The crate remains version 0.18.5 because GTK3 requires that version family; GitHub may still report GHSA-wrw7-89jp-8q8g. Keep monitoring the alert and remove this backport when the supported Tauri GTK stack can use an official fixed release.

OpenAI-Codex
