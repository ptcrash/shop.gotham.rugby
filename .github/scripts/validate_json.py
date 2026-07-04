#!/usr/bin/env python3
"""Validate every JSON file in the theme.

Shopify theme JSON (templates, config, section groups) permits leading /* */
block comments (JSONC); locale files are strict JSON. Theme Check does not
reliably catch a malformed locale file — an invalid locales/*.schema.json
silently breaks every editor label — so we validate JSON here as a hard gate.
"""
import glob
import json
import re
import sys

PATTERNS = [
    "templates/**/*.json",
    "config/*.json",
    "sections/*.json",       # section groups (header-group.json, footer-group.json)
    "locales/*.json",
]

# Shopify JSONC allows /* ... */ comments in template/config/group files.
COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)


def main() -> int:
    files = sorted({f for pat in PATTERNS for f in glob.glob(pat, recursive=True)})
    errors = []
    for path in files:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read()
        # Strip block comments (harmless for comment-free locale files).
        stripped = COMMENT_RE.sub("", raw)
        try:
            json.loads(stripped)
        except json.JSONDecodeError as exc:
            errors.append(f"{path}:{exc.lineno}:{exc.colno}: {exc.msg}")

    if errors:
        print("::error::Invalid JSON detected")
        for e in errors:
            print(f"  - {e}")
        return 1

    print(f"OK — {len(files)} JSON files are valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
