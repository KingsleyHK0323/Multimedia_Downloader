# OpenAI-Codex: verify and exercise the exact GLib 0.18 backport in optimized mode.
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

REVISION = "1677375f54686a3fe2f1f383e068aa005606013b"
SOURCE = (
    "git+https://github.com/KingsleyHK0323/Multimedia_Downloader"
    f"?rev={REVISION}#{REVISION}"
)
ROOT = Path(__file__).resolve().parents[2]
TAURI = ROOT / "src-tauri"


def main():
    cargo = shutil.which("cargo")
    if cargo is None:
        raise RuntimeError("The trusted Rust toolchain is unavailable.")
    cargo = str(Path(cargo).resolve(strict=True))
    metadata = json.loads(
        subprocess.check_output(
            [cargo, "metadata", "--locked", "--format-version", "1"],
            cwd=TAURI,
            text=True,
        )
    )
    matches = [
        package
        for package in metadata["packages"]
        if package["name"] == "glib" and package["version"] == "0.18.5"
    ]
    if len(matches) != 1 or matches[0]["source"] != SOURCE:
        raise RuntimeError("The application did not resolve the pinned GLib backport.")
    glib_dir = Path(matches[0]["manifest_path"]).resolve().parent
    source = (glib_dir / "src" / "variant_iter.rs").read_text(encoding="utf-8")
    if (
        "// OpenAI-Codex: backport upstream GLib soundness fix #1343." not in source
        or "let mut p: *mut libc::c_char = std::ptr::null_mut();" not in source
        or "                &mut p," not in source
    ):
        raise RuntimeError("The resolved GLib iterator does not contain the expected backport.")

    temp_root = Path(os.environ["RUNNER_TEMP"])
    probe = Path(tempfile.mkdtemp(prefix="glib-backport-probe-", dir=temp_root))
    (probe / "src").mkdir()
    (probe / "Cargo.toml").write_text(
        '[package]\nname = "glib-backport-probe"\nversion = "0.0.0"\nedition = "2021"\n'
        '[workspace]\n[dependencies]\nglib = { path = '
        + json.dumps(str(glib_dir))
        + ' }\n',
        encoding="utf-8",
    )
    (probe / "src" / "lib.rs").write_text(
        r'''
// OpenAI-Codex: cover both directions and optimized string iteration.
#[cfg(test)]
mod tests {
    use glib::{prelude::*, variant::Variant};

    #[test]
    fn string_iterator_uses_initialized_output_pointer() {
        let value = Variant::array_from_iter::<String>([
            "alpha".to_variant(),
            "beta".to_variant(),
            "gamma".to_variant(),
        ]);
        let mut iter = value.array_iter_str().expect("string array");
        assert_eq!(iter.next(), Some("alpha"));
        assert_eq!(iter.next_back(), Some("gamma"));
        assert_eq!(iter.next(), Some("beta"));
        assert_eq!(iter.next(), None);
        assert_eq!(value.array_iter_str().unwrap().nth(1), Some("beta"));
        assert_eq!(value.array_iter_str().unwrap().nth_back(1), Some("beta"));
        assert_eq!(value.array_iter_str().unwrap().last(), Some("gamma"));
    }
}
''',
        encoding="utf-8",
    )
    env = dict(os.environ, CARGO_TARGET_DIR=str(probe / "target"))
    # OpenAI-Codex: cargo comes from the configured CI toolchain; arguments are fixed.
    subprocess.run(  # noqa: S603
        [cargo, "test", "--release", "--offline", "--manifest-path", str(probe / "Cargo.toml")],
        cwd=probe,
        env=env,
        check=True,
    )


if __name__ == "__main__":
    main()
