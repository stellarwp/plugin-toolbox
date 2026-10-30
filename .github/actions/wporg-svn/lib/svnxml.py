#!/usr/bin/env python3
"""Answer questions about the XML that svn prints. The XML arrives on stdin.

Usage:
  svnxml.py kind NAME     print dir, file or absent for NAME in `svn list --xml`
  svnxml.py names         print every entry name in `svn list --xml`
  svnxml.py check-props   exit 1 when `svn proplist -R --xml` shows a property
                          that rewrites file bytes or pulls content from elsewhere
  svnxml.py diff-empty    exit 0 when `svn diff --summarize --xml` lists nothing

Unreadable XML exits 3, so it is never mistaken for an answer.
"""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET

# Checked-out bytes differ from repository bytes under these, or content comes
# from another location. An exact artifact release cannot keep them.
TRANSFORMING = ("svn:eol-style", "svn:externals", "svn:keywords", "svn:special")


def main(argv) -> int:
    command, args = (argv[0], argv[1:]) if argv else ("", [])
    if (command, len(args)) not in (("kind", 1), ("names", 0), ("check-props", 0), ("diff-empty", 0)):
        print(__doc__, file=sys.stderr)
        return 2
    try:
        doc = ET.parse(sys.stdin.buffer).getroot()
    except ET.ParseError:
        print("error: unreadable svn XML", file=sys.stderr)
        return 3

    if command == "kind":
        kinds = [entry.get("kind") for entry in doc.iter("entry") if entry.findtext("name") == args[0]]
        print(kinds[0] if kinds else "absent")
    elif command == "names":
        for entry in doc.iter("entry"):
            print(entry.findtext("name"))
    elif command == "check-props":
        counts = {}
        for prop in doc.iter("property"):
            if prop.get("name") in TRANSFORMING:
                counts[prop.get("name")] = counts.get(prop.get("name"), 0) + 1
        for name, count in sorted(counts.items()):
            print(f"error: {count} path(s) set {name}", file=sys.stderr)
        return 1 if counts else 0
    elif command == "diff-empty":
        changed = len(list(doc.iter("path")))
        if changed:
            print(f"{changed} path(s) differ", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
