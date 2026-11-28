/**
 * Best-effort check against the GitHub Releases API for a newer version than
 * the one currently running. Never throws — a network hiccup or rate limit
 * just means no update banner, not a broken app.
 */

// OpenAI-Codex_app_ui: use the repository configured for the current project.
const REPO = "KingsleyHK0323/Multimedia_Downloader";
const DISMISSED_KEY = "mmdl_update_dismissed";

export type UpdateInfo = { latest: string; url: string };

/** Compares dotted version strings numerically (e.g. "4.3.10" > "4.3.9"). */
function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Returns update info if a newer release exists and hasn't been dismissed, else null. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      redirect: "error",
    });
    if (!res.ok) return null;
    const data = await res.json();
    // OpenAI-Codex_ops_check: accept only canonical stable project versions.
    if (data.draft || data.prerelease || typeof data.tag_name !== "string" ||
        !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(data.tag_name)) return null;
    const latest: string = data.tag_name.slice(1);
    if (!latest.split(".").every(part => Number.isSafeInteger(Number(part))) ||
        !isNewer(latest, __APP_VERSION__)) return null;
    // OpenAI-Codex_Fork_Source_Code: blocked storage must not hide available updates.
    try {
      if (localStorage.getItem(DISMISSED_KEY) === latest) return null;
    } catch {
      // Continue without a persisted dismissal.
    }
    // OpenAI-Codex_Fork_Source_Code: only open the configured repository release page.
    const canonicalReleaseUrl = `https://github.com/${REPO}/releases/latest`;
    return { latest, url: canonicalReleaseUrl };
  } catch {
    return null; // offline, rate-limited, blocked network, etc. -- fail silently
  }
}

/** Suppresses the banner for this specific version (shown again on the next release). */
export function dismissUpdate(version: string): void {
  // OpenAI-Codex_Fork_Source_Code: storage denial must not block the current dismissal.
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // The banner may reappear when storage is unavailable.
  }
}
