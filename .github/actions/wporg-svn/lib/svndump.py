#!/usr/bin/env python3
"""Answer questions about the stream `svnrdump dump -r REV URL` prints. It arrives on stdin.

Usage:
  svndump.py check-props   exit 1 when any path sets a property that rewrites
                           file bytes or pulls content from elsewhere

The stream must be a one-revision, non-incremental dump, where every path is
added in full with all its properties. Anything else, or anything malformed,
exits 3, so it is never mistaken for "no properties". The whole stream is read
even then, so svnrdump is never cut off by a closed pipe. A stream cut exactly
between two records still looks whole: completeness comes from svnrdump's own
exit status, which the caller must check.
"""

from __future__ import annotations

import sys

from svnxml import TRANSFORMING


class DumpError(Exception):
    pass


def _headers(stream):
    """The next record's headers as {name: bytes}, or None at the end."""
    line = stream.readline()
    while line == b"\n":
        line = stream.readline()
    if not line:
        return None
    headers = {}
    while line != b"\n":
        name, separator, value = line.rstrip(b"\n").partition(b": ")
        if not line.endswith(b"\n"):
            raise DumpError("the stream ends inside a record")
        if not separator or not name.isascii():
            raise DumpError("malformed header")
        headers[name.decode()] = value
        line = stream.readline()
    return headers


def _length(headers, name):
    value = headers.get(name, b"0")
    if not value.isdigit():
        raise DumpError(f"malformed {name}")
    return int(value)


def _read(stream, size):
    data = stream.read(size)
    if len(data) != size:
        raise DumpError("the stream ends inside a record")
    return data


def _skip(stream, size):
    while size:
        size -= len(_read(stream, min(size, 1 << 20)))


def _text(value, what):
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError:
        raise DumpError(f"{what} is not UTF-8") from None


def _names(block):
    """Property names in a K/V block that ends in PROPS-END."""
    names, position = [], 0

    def field(tag):
        nonlocal position
        end = block.find(b"\n", position)
        line = block[position:end] if end >= 0 else b""
        if not (line.startswith(tag + b" ") and line[2:].isdigit()):
            raise DumpError("malformed properties")
        start = end + 1
        position = start + int(line[2:])
        if block[position:position + 1] != b"\n":
            raise DumpError("malformed properties")
        position += 1
        return block[start:position - 1]

    while block[position:] != b"PROPS-END\n":
        names.append(_text(field(b"K"), "a property name"))
        field(b"V")
    return names


def properties(stream) -> set:
    """{(path, property name)} for every path in the dump."""
    first = _headers(stream)
    if first is None or first.get("SVN-fs-dump-format-version") != b"3":
        raise DumpError("not a version 3 dump")
    found, paths = set(), 0
    while True:
        headers = _headers(stream)
        if headers is None:
            break
        props, text = _length(headers, "Prop-content-length"), _length(headers, "Text-content-length")
        if "Content-length" in headers and _length(headers, "Content-length") != props + text:
            raise DumpError("record lengths disagree")
        block = _read(stream, props)
        _skip(stream, text)
        if "Node-path" not in headers:
            if "Revision-number" not in headers and "UUID" not in headers:
                raise DumpError("unknown record")
            continue
        if (headers.get("Node-action") != b"add" or headers.get("Node-kind") not in (b"file", b"dir")
                or "Node-copyfrom-path" in headers or "Node-copyfrom-rev" in headers):
            raise DumpError("a path that is not a plain addition")
        path = _text(headers["Node-path"], "a path")
        paths += 1
        for name in _names(block) if props else []:
            found.add((path, name))
    if not paths:
        raise DumpError("no paths")
    return found


def check(stream) -> dict:
    """{property: number of paths} for the byte-changing properties in the dump."""
    counts = {}
    for _, name in properties(stream):
        if name in TRANSFORMING:
            counts[name] = counts.get(name, 0) + 1
    return counts


def main(argv) -> int:
    if argv != ["check-props"]:
        print(__doc__, file=sys.stderr)
        return 2
    stream = sys.stdin.buffer
    try:
        counts = check(stream)
    except DumpError as error:
        print(f"error: unreadable svnrdump output: {error}", file=sys.stderr)
        return 3
    finally:
        while stream.read(1 << 20):
            pass
    for name, count in sorted(counts.items()):
        print(f"error: {count} path(s) set {name}", file=sys.stderr)
    return 1 if counts else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
