#!/usr/bin/env python3
"""Refuse SVN writes to anything but file:// repositories.

Test-only. The bin/ shims put this in front of the real svn, svnmucc and
svnrdump, so no test, fixture or QA run can write to a production repository,
even by mistake.
Reads pass straight through. The rule is deliberately conservative: anything
that looks like a write is checked, and a false refusal only fails loudly.

Usage: write_guard.py svn|svnmucc|svnrdump ARGS...
With WRITE_GUARD_LOG set, every argv is appended to that file as a JSON line.
"""

import json
import os
import re
import subprocess
import sys

BIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin")
URL = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*)://")

# svn subcommands that commit, or that commit when given a URL.
SVN_WRITES = {
    "commit", "ci", "import", "mkdir", "copy", "cp", "move", "mv", "rename", "ren", "delete", "del",
    "remove", "rm", "propset", "pset", "ps", "propdel", "pdel", "pd", "propedit", "pedit", "pe",
    "lock", "unlock",
}


def is_remote(value):
    match = URL.match(value)
    return bool(match) and match.group(1).lower() != "file"


def real(tool):
    """The tool from the PATH entries after the guard's own (wrappers come before it)."""
    guard = os.path.realpath(BIN)
    path = [d for d in os.environ.get("PATH", "").split(os.pathsep) if d]
    resolved = [os.path.realpath(d) for d in path]
    if guard in resolved:
        path = path[resolved.index(guard) + 1:]
    for directory in path:
        if os.path.realpath(directory) == guard:
            continue
        candidate = os.path.join(directory, tool)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    sys.exit(f"write-guard: no real {tool} on PATH")


def repo_root(path):
    result = subprocess.run([real("svn"), "info", "--non-interactive", "--show-item", "repos-root-url", "--", path + "@"],
                            capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


def refusal(tool, args, root_of=repo_root):
    """Why this command must not run, or None when it is a read or a local write."""
    if tool == "svnmucc":
        urls = [arg for arg in args if URL.match(arg)]
        if not urls:
            return "svnmucc without an explicit file:// URL"
        if any(is_remote(url) for url in urls):
            return "svnmucc to a non-file:// repository"
        return None

    if tool == "svnrdump":
        if "load" not in args:
            return None
        urls = [arg for arg in args if URL.match(arg)]
        if not urls or any(is_remote(url) for url in urls):
            return "svnrdump load into anything but a file:// repository"
        return None

    if not SVN_WRITES.intersection(args) and "--revprop" not in args:
        return None
    if any(is_remote(arg) for arg in args):
        return "svn write to a non-file:// repository"
    paths = [arg for arg in args if not arg.startswith("-") and os.path.exists(arg.rsplit("@", 1)[0])]
    for path in paths + ["."]:
        root = root_of(path)
        if root and is_remote(root):
            return "svn write from a working copy of a non-file:// repository"
    return None


def main():
    tool, args = sys.argv[1], sys.argv[2:]
    if os.environ.get("WRITE_GUARD_LOG"):
        with open(os.environ["WRITE_GUARD_LOG"], "a") as log:
            log.write(json.dumps([tool] + args) + "\n")
    reason = refusal(tool, args)
    if reason:
        print(f"write-guard: refused: {reason}", file=sys.stderr)
        sys.exit(99)
    os.execv(real(tool), [tool] + args)


if __name__ == "__main__":
    main()
