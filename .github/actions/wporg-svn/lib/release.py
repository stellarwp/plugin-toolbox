#!/usr/bin/env python3
"""Release metadata: numeric versions, the readme Stable Tag, the plugin header.

Usage:
  release.py version V            exit 0 when V is a numeric version
  release.py compare A B          print lt, eq or gt
  release.py equivalents V        print the stdin lines numerically equal to V
  release.py stable-tag README    print the readme's Stable Tag value
  release.py plugin-version DIR   print the Version header of DIR's plugin file

Errors go to stderr without echoing file contents, and exit 1.
"""

from __future__ import annotations

import collections
import os
import re
import sys

VERSION = re.compile(r"[0-9]+(?:\.[0-9]+)*")

# WordPress reads plugin headers from the first 8 KiB only (get_file_data).
HEADER_BYTES = 8192

# Header names the wordpress.org readme parser recognises (class-parser.php).
README_HEADERS = {
    "tested", "tested up to", "requires", "requires at least", "requires php", "tags",
    "contributors", "donate link", "stable tag", "license", "license uri",
}

# PCRE's \R, which the readme parser splits lines on.
NEWLINES_UTF8 = re.compile("\r\n|[\n\x0b\x0c\r\x85  ]")
NEWLINES_BYTES = re.compile("\r\n|[\n\x0b\x0c\r\x85]")


class ReleaseError(Exception):
    pass


def is_version(value: str) -> bool:
    return VERSION.fullmatch(value) is not None


def _key(value: str) -> list:
    if not is_version(value):
        raise ReleaseError("not a numeric version")
    # Compare digit strings by (length, text) after dropping leading zeros:
    # arbitrary precision without int(), which caps digit count on 3.11+.
    return [(len(part), part) for part in (p.lstrip("0") or "0" for p in value.split("."))]


def compare(left: str, right: str) -> int:
    a, b = _key(left), _key(right)
    width = max(len(a), len(b))
    a += [(1, "0")] * (width - len(a))
    b += [(1, "0")] * (width - len(b))
    return (a > b) - (a < b)


def equivalents(version: str, names) -> list:
    return [name for name in names if is_version(name) and compare(name, version) == 0]


def _php_empty(value) -> bool:
    return value in ("", "0", b"", b"0")


def _ascii_lower(value: str) -> str:
    return "".join(c.lower() if "A" <= c <= "Z" else c for c in value)


def _readme_header(line: str, only_valid: bool = False):
    if ":" not in line or line.startswith(("#", "=")):
        return None
    key, value = line.split(":", 1)
    key = _ascii_lower(key.strip(" \t*-\r\n"))
    if only_valid and key not in README_HEADERS:
        return None
    return key, value


def stable_tag(data: bytes) -> str:
    """Return the readme's single Stable Tag value, whitespace-trimmed.

    The header section ends where the wordpress.org readme parser ends it, so
    examples further down the readme never count.
    """
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise ReleaseError("readme.txt is UTF-16; only UTF-8 is supported")
    try:
        encoding, lines = "utf-8", NEWLINES_UTF8.split(data.decode("utf-8"))
    except UnicodeDecodeError:
        encoding, lines = "latin-1", NEWLINES_BYTES.split(data.decode("latin-1"))
    stack = collections.deque(lines)

    def first_nonwhitespace():
        while stack:
            line = stack.popleft()
            if not _php_empty(line.strip(" \t\n\r\0\x0b")):
                return line
        return ""

    # Title line, unless the readme starts straight with a header field.
    line = first_nonwhitespace()
    name = line.strip("#= \t\0\x0b")
    if _readme_header(line, only_valid=True):
        stack.appendleft(line)
        name = ""
    if stack and stack[0].strip("=-") == "":
        stack.popleft()
    if _ascii_lower(name) == "plugin name":
        line = first_nonwhitespace()
        if len(line.encode(encoding)) >= 50 or _readme_header(line, only_valid=True):
            stack.appendleft(line)

    found = []
    line = first_nonwhitespace()
    last_blank = False
    while True:
        header = _readme_header(line)
        if header is None:
            if not _php_empty(line):
                break  # The short description: the header section is over.
            last_blank = True
        else:
            key, value = header
            if key == "stable tag":
                found.append(value)
            elif key not in README_HEADERS and last_blank:
                break
            last_blank = False
        if not stack:
            break
        line = stack.popleft()

    if not found:
        raise ReleaseError("readme.txt has no Stable Tag field in its header")
    if len(found) > 1:
        raise ReleaseError(f"readme.txt has {len(found)} Stable Tag fields in its header")
    return found[0].strip(" \t")


def _plugin_headers(data: bytes, name: bytes) -> list:
    """Every match of WordPress's header regex, cleaned like get_file_data."""
    pattern = re.compile(rb"^(?:[ \t]*<\?php)?[ \t/*#@]*" + re.escape(name) + rb":(.*)$", re.M | re.I)
    values = []
    for match in pattern.finditer(data):
        raw = match.group(1)
        cleaned = re.sub(rb"\s*(?:\*/|\?>).*", b"", raw).strip(b" \t\n\r\0\x0b")
        values.append(b"" if _php_empty(raw) else cleaned)
    return values


def plugin_version(root: str) -> str:
    """Return the Version header of the one root PHP file declaring a plugin."""
    plugins = []
    for entry in sorted(os.listdir(root)):
        path = os.path.join(root, entry)
        if not entry.endswith(".php") or os.path.islink(path) or not os.path.isfile(path):
            continue
        with open(path, "rb") as handle:
            data = handle.read(HEADER_BYTES).replace(b"\r", b"\n")
        names = _plugin_headers(data, b"Plugin Name")
        if not any(not _php_empty(value) for value in names):
            continue
        if len(names) > 1:
            raise ReleaseError(f"a root PHP file has {len(names)} Plugin Name headers")
        plugins.append(data)

    if not plugins:
        raise ReleaseError("no root PHP file has a Plugin Name header")
    if len(plugins) > 1:
        raise ReleaseError(f"{len(plugins)} root PHP files have a Plugin Name header")

    versions = _plugin_headers(plugins[0], b"Version")
    if len(versions) > 1:
        raise ReleaseError(f"the plugin file has {len(versions)} Version headers")
    if not versions or _php_empty(versions[0]):
        raise ReleaseError("the plugin file has no Version header")
    version = versions[0].decode("latin-1")
    if not is_version(version):
        raise ReleaseError("the plugin Version header is not a numeric version")
    return version


def main(argv) -> int:
    command, args = (argv[0], argv[1:]) if argv else ("", [])
    try:
        if command == "version" and len(args) == 1:
            return 0 if is_version(args[0]) else 1
        if command == "compare" and len(args) == 2:
            print({-1: "lt", 0: "eq", 1: "gt"}[compare(*args)])
        elif command == "equivalents" and len(args) == 1:
            for name in equivalents(args[0], sys.stdin.read().splitlines()):
                print(name)
        elif command == "stable-tag" and len(args) == 1:
            with open(args[0], "rb") as handle:
                print(stable_tag(handle.read()))
        elif command == "plugin-version" and len(args) == 1:
            print(plugin_version(args[0]))
        else:
            print(__doc__, file=sys.stderr)
            return 2
    except (ReleaseError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
