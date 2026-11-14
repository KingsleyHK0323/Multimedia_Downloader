#!/usr/bin/env python3
"""
Report whether the AI assistant's default model ids are still live.

`ai/models.resolve_roster()` already keeps the assistant working when a model
is retired, by substituting a live free one. That makes retirement survivable,
not invisible: every user then sees a substitution warning, and the substitute
is whatever happens to be available rather than one that was chosen for the
role. The free tier churns roughly every couple of months -- three rounds are
on record -- so this is run on a schedule to surface the drift while it is
still a maintenance task rather than a user-facing surprise.

Local draft note (OpenAI-Codex_Fork_GitHub_REPO): the CLI wrapper below uses
0 for no observed substitution, 2 for a normally inconclusive catalogue,
3 for a substitution, and 5 for caught execution faults or unexpected results.
The legacy main() function and historical exit-code description below retain
their earlier contract; do not infer model retirement from a substitution.

Exit codes:
    0  every default is live
    1  at least one default has been retired (details on stdout)
    2  the catalogue could not be read -- inconclusive, not a failure of the roster

Loads ai/models.py directly rather than importing the `ai` package, whose
__init__ pulls in the engine and therefore yt-dlp. This way the workflow needs
no dependencies at all.
"""

from __future__ import annotations

import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_models_module():
    path = os.path.join(ROOT, "ai", "models.py")
    spec = importlib.util.spec_from_file_location("_mmdl_ai_models", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    # @dataclass resolves annotations through sys.modules[cls.__module__], so
    # the module has to be registered before it is executed, not after.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    models = _load_models_module()
    roster = models.resolve_roster(use_cache=False)

    if not roster.verified:
        print("Could not read the OpenRouter catalogue — result is inconclusive.")
        for note in roster.notes:
            print(f"  {note}")
        return 2

    defaults = {m.role: m for m in models.ROSTER}
    retired = [role for role, want in defaults.items()
               if roster.get(role).slug != want.slug]

    for role, want in defaults.items():
        live = roster.get(role)
        if role in retired:
            print(f"RETIRED  {role:<11} {want.slug}")
            print(f"         would now fall back to {live.slug}")
        else:
            print(f"live     {role:<11} {want.slug}")

    if not retired:
        print("\nAll four defaults are still live — nothing to do.")
        return 0

    print(f"\n{len(retired)} of {len(defaults)} defaults have been retired: "
          f"{', '.join(retired)}.")
    print("Update the constants in ai/models.py to currently live ids; the list "
          "above shows what resolve_roster() picks in the meantime.")
    return 1


if __name__ == "__main__":
    # Suppress legacy retirement wording; the check establishes only a substitution.
    import contextlib
    import io

    _legacy_roster_main = main

    def main():
        with contextlib.redirect_stdout(io.StringIO()):
            return _legacy_roster_main()

# OpenAI-Codex_Fork_GitHub_REPO: distinguish an observed roster substitution
# from process errors; neither proves that an upstream model was retired.
if __name__ == "__main__":
    try:
        _observed_status = main()
    except BaseException as _error:
        print(f"Roster check failed; result is inconclusive ({type(_error).__name__}).", file=sys.stderr)
        # OpenAI-Codex_Fork_GitHub_REPO: execution faults are not catalogue unavailability.
        sys.exit(5)
        sys.exit(2)
    # OpenAI-Codex_Fork_GitHub_REPO: unexpected return values are execution faults.
    if _observed_status not in (0, 1, 2):
        print("Roster check returned an unexpected status.", file=sys.stderr)
        sys.exit(5)
    # OpenAI-Codex_Fork_GitHub_REPO: workflow-only completion evidence.
    _workflow_token = os.environ.get("MMDL_ROSTER_COMPLETION_TOKEN")
    if _workflow_token:
        import re
        if re.fullmatch(r"roster-[0-9]+-[0-9]+-[0-9]+-[0-9]+", _workflow_token) is None:
            print("Invalid roster completion token.", file=sys.stderr)
            sys.exit(5)
        _workflow_status = 3 if _observed_status == 1 else _observed_status
        print(f"MMDL_ROSTER_COMPLETE {_workflow_token} {_workflow_status}")
    if _observed_status == 1:
        print("A default differs from its selected roster candidate; retirement is unverified.")
    elif _observed_status == 0:
        print("No default roster substitution was observed.")
    else:
        print("Roster state is inconclusive.")
    if _observed_status == 1:
        sys.exit(3)
    sys.exit(_observed_status if _observed_status in (0, 2) else 2)

if __name__ == "__main__":
    sys.exit(main())
