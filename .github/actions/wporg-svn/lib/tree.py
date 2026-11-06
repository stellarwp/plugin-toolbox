#!/usr/bin/env python3
"""Make a working copy match an artifact tree exactly, and compare trees.

Usage:
  tree.py sync SRC WC              make WC's files match SRC; WC/.svn is untouched
  tree.py reconcile WC CONFIG_DIR  schedule the SVN adds, deletes and replacements
                                   that make WC commit as it now is; print the
                                   number of changed paths
  tree.py compare A B              exit 0 when A and B hold the same paths, kinds
                                   and bytes (a top-level .svn is ignored)
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

FIXABLE = {"unversioned", "ignored", "missing", "obstructed", "modified"}
COMMITTABLE = {"added", "deleted", "replaced", "modified"}
# Not "copied": tag reconciles a fresh copy, where every changed node is copied.
FLAGS = ("tree-conflicted", "switched", "wc-locked")


class TreeError(Exception):
    pass


def _kind(path):
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        return None
    if stat.S_ISDIR(mode):
        return "dir"
    return "file" if stat.S_ISREG(mode) else "other"


def entries(root) -> dict:
    """{relative path: kind} under root, skipping a top-level .svn."""
    found = {}
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        if rel == ".":
            dirnames[:] = [d for d in dirnames if d != ".svn"]
        for name in dirnames + filenames:
            path = os.path.normpath(os.path.join(rel, name))
            found[path] = _kind(os.path.join(root, path))
    return found


def _depth(path):
    return path.count(os.sep)


def _same_bytes(a, b) -> bool:
    if os.path.getsize(a) != os.path.getsize(b):
        return False
    with open(a, "rb") as left, open(b, "rb") as right:
        while True:
            chunk = left.read(1024 * 1024)
            if chunk != right.read(1024 * 1024):
                return False
            if not chunk:
                return True


def _remove(path):
    if _kind(path) == "dir":
        shutil.rmtree(path)
    else:
        os.unlink(path)


def sync(src, wc):
    """Make wc's tree (outside .svn) equal src's: kinds, paths and bytes."""
    want, have = entries(src), entries(wc)
    if "other" in want.values():
        raise TreeError("the artifact contains something other than files and directories")
    for rel in sorted(have, key=_depth):
        if want.get(rel) != have[rel] and os.path.lexists(os.path.join(wc, rel)):
            _remove(os.path.join(wc, rel))
    for rel in sorted(want, key=_depth):
        source, target = os.path.join(src, rel), os.path.join(wc, rel)
        if want[rel] == "dir":
            os.makedirs(target, exist_ok=True)
        elif not os.path.lexists(target) or not _same_bytes(source, target):
            if os.path.lexists(target):
                os.unlink(target)
            shutil.copyfile(source, target)


class _Svn:
    def __init__(self, config):
        self.base = ["svn", "--non-interactive", "--config-dir", config]

    def run(self, *args) -> bytes:
        result = subprocess.run(self.base + list(args), capture_output=True)
        if result.returncode:
            raise TreeError(f"svn {args[0]} failed: " + result.stderr.decode("utf-8", "replace").strip()[-300:])
        return result.stdout

    def status(self, wc) -> list:
        """(path, item, props, flags) for every entry svn reports.

        A copy scheduled for addition (svn copy URL WC) reports its root as
        added; that is the copy itself, not a change to reconcile or count.
        """
        doc = ET.fromstring(self.run("status", "--xml", "--no-ignore", "--", wc + "@"))
        found = []
        for entry in doc.iter("entry"):
            status = entry.find("wc-status")
            if entry.get("path") == wc and status.get("item") == "added" and status.get("copied") == "true":
                continue
            flags = {flag for flag in FLAGS if status.get(flag) == "true"}
            found.append((entry.get("path"), status.get("item"), status.get("props"), flags))
        return found

    def _each(self, args, paths):
        """Run svn args once for all paths, listed in a --targets file."""
        if not paths:
            return
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".targets") as targets:
            targets.write("".join(path + "@\n" for path in paths))
            targets.flush()
            self.run(*args, "--targets", targets.name)

    def add(self, *paths):
        self._each(["add", "--depth", "infinity", "--no-ignore", "--no-auto-props"], paths)

    def rm(self, *paths):
        self._each(["rm", "--force"], paths)


def _check(found, allowed, when):
    # svn add itself sets svn:mime-type on binary files, so added items may carry
    # properties; the caller checks the working copy's properties separately.
    bad = sorted({f"{item} (props {props}{', ' + ', '.join(sorted(flags)) if flags else ''})"
                  for _, item, props, flags in found if item not in allowed or props == "conflicted" or flags})
    if bad:
        raise TreeError(f"unexpected working copy state {when}: " + "; ".join(bad))


def _tops(paths) -> list:
    """paths without those inside another of them: svn add and rm recurse."""
    tops = set()
    for path in sorted(paths, key=_depth):
        parent = os.path.dirname(path)
        while parent not in tops and parent != os.path.dirname(parent):
            parent = os.path.dirname(parent)
        if parent not in tops:
            tops.add(path)
    return sorted(tops)


def reconcile(wc, config) -> int:
    """Schedule SVN operations so wc commits as it is on disk; return the change count."""
    svn = _Svn(config)
    _check(svn.status(wc), FIXABLE, "before reconciling")

    # A file became a directory or the reverse: delete the old node, add the new.
    for path, item, _, _ in svn.status(wc):
        if item == "obstructed":
            aside = tempfile.mkdtemp(dir=os.path.dirname(wc))
            os.rename(path, os.path.join(aside, "item"))
            svn.rm(path)
            os.rename(os.path.join(aside, "item"), path)
            os.rmdir(aside)
            svn.add(path)

    svn.rm(*_tops(p for p, item, _, _ in svn.status(wc) if item == "missing"))
    svn.add(*_tops(p for p, item, _, _ in svn.status(wc) if item in ("unversioned", "ignored")))

    final = svn.status(wc)
    _check(final, COMMITTABLE, "after reconciling")
    return len(final)


def compare(a, b) -> list:
    """Relative paths whose presence, kind or bytes differ between a and b."""
    left, right = entries(a), entries(b)
    differ = [rel for rel in sorted(set(left) | set(right)) if left.get(rel) != right.get(rel)]
    for rel in sorted(set(left) & set(right)):
        if left[rel] == "file" == right[rel] and not _same_bytes(os.path.join(a, rel), os.path.join(b, rel)):
            differ.append(rel)
    return differ


def main(argv) -> int:
    command, args = (argv[0], argv[1:]) if argv else ("", [])
    try:
        if command == "sync" and len(args) == 2:
            sync(*args)
        elif command == "reconcile" and len(args) == 2:
            print(reconcile(*args))
        elif command == "compare" and len(args) == 2:
            differ = compare(*args)
            if differ:
                print(f"error: {len(differ)} path(s) differ, for example:", file=sys.stderr)
                for rel in differ[:10]:
                    print(f"  differs: {rel}", file=sys.stderr)
                return 1
        else:
            print(__doc__, file=sys.stderr)
            return 2
    except (TreeError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
