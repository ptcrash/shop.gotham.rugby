#!/usr/bin/env python3
"""Bump theme_version in config/settings_schema.json and push it to staging.

The version shows on the theme card in Online Store -> Themes, and
.github/workflows/release.yml mints a git tag v<version> + GitHub Release
(with auto-generated notes) when the bumped version reaches main.

Usage:
  python3 .github/scripts/bump_theme_version.py --print
      Print the current theme_version from the local working tree (used by
      release.yml) and exit.

  python3 .github/scripts/bump_theme_version.py major|minor|patch [--dry-run]
  python3 .github/scripts/bump_theme_version.py 1.2.3 [--dry-run]
      Commit the bump directly to origin/staging (admin bypass — the same
      mechanics as post-merge true-ups) via a temporary worktree; your local
      checkout is never touched. Run it right before opening the
      staging -> main PR (or while one is open — the PR picks it up) so the
      promotion carries the new version. --dry-run shows what would be
      pushed without pushing.

Shop semver — see AGENTS.md "Releases & theme version" for the full rubric:
  major — redesign/overhaul, or anything the previous tag can't cleanly roll back
  minor — behavior/functionality changes, incl. admin-coordinated ones
  patch — cosmetic only (copy, CSS, spacing, images)
"""

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SCHEMA = "config/settings_schema.json"
VERSION_RE = re.compile(r'("theme_version"\s*:\s*")([0-9]+\.[0-9]+\.[0-9]+)(")')


def run(*cmd, **kw):
    return subprocess.run(cmd, check=True, text=True, capture_output=True, **kw).stdout


def read_version(text, where):
    m = VERSION_RE.search(text)
    if not m:
        sys.exit(f"error: no semver theme_version found in {where}")
    return m.group(2)


def main():
    dry = "--dry-run" in sys.argv[1:]
    args = [a for a in sys.argv[1:] if a != "--dry-run"]

    if args == ["--print"]:
        root = run("git", "rev-parse", "--show-toplevel").strip()
        print(read_version(Path(root, SCHEMA).read_text(), SCHEMA))
        return
    if len(args) != 1:
        sys.exit(__doc__)
    level = args[0]

    run("git", "fetch", "origin")
    current = read_version(run("git", "show", f"origin/staging:{SCHEMA}"), f"origin/staging:{SCHEMA}")
    major, minor, patch = map(int, current.split("."))
    if level == "major":
        new = f"{major + 1}.0.0"
    elif level == "minor":
        new = f"{major}.{minor + 1}.0"
    elif level == "patch":
        new = f"{major}.{minor}.{patch + 1}"
    elif re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", level):
        new = level
    else:
        sys.exit(f"error: expected major|minor|patch|X.Y.Z, got {level!r}")
    if new == current:
        sys.exit(f"error: origin/staging is already at {current}")

    with tempfile.TemporaryDirectory() as tmp:
        worktree = str(Path(tmp, "staging"))
        run("git", "worktree", "add", "--detach", worktree, "origin/staging")
        try:
            schema_path = Path(worktree, SCHEMA)
            text, n = VERSION_RE.subn(lambda m: m.group(1) + new + m.group(3), schema_path.read_text(), count=1)
            if n != 1:
                sys.exit(f"error: expected exactly one theme_version in {SCHEMA}")
            json.loads(text)  # the edit must leave the schema parseable
            schema_path.write_text(text)
            run("git", "-C", worktree, "commit", "-am", f"Bump theme version to {new}")
            if dry:
                print(run("git", "-C", worktree, "show", "--stat", "HEAD"))
                print(f"dry run: would push {current} -> {new} to origin/staging")
            else:
                run("git", "-C", worktree, "push", "origin", "HEAD:refs/heads/staging")
                print(f"Bumped theme version {current} -> {new} on staging.")
                print("Next: open (or refresh) the staging -> main PR; merging it mints the release.")
        finally:
            run("git", "worktree", "remove", "--force", worktree)


if __name__ == "__main__":
    main()
