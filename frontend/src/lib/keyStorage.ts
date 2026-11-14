// OpenAI-Codex_app_ui: present only verified key-persistence states.
export type KeySaveState = "pending" | "idle" | "saved" | "failed";

export function keyStorageView(input: {
  remember: boolean;
  hasValue: boolean;
  saveState: KeySaveState;
  savedKeyExists: boolean;
  possibleLegacy: boolean;
}): { hint: string | null; legacy: string | null } {
  if (input.remember && input.hasValue) {
    if (input.saveState === "saved") return { hint: "ai_key_saved_hint", legacy: null };
    if (input.saveState === "failed") return { hint: "ai_key_save_failed_hint", legacy: null };
    return { hint: null, legacy: null };
  }
  return {
    hint: "ai_key_session_hint",
    legacy: input.savedKeyExists ? "ai_key_legacy_hint" : input.possibleLegacy ? "ai_key_legacy_possible_hint" : null,
  };
}
