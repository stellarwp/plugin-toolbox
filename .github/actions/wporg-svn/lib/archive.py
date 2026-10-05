#!/usr/bin/env python3
"""Inspect a plugin ZIP before extracting anything, then extract it safely.

Usage:
  archive.py extract ZIP DEST   extract into the empty directory DEST and print
                                the plugin root (DEST or its one wrapper directory)

Every entry is checked before the first byte is written. Errors go to stderr
without echoing entry names, and exit 1.
"""

from __future__ import annotations

import os
import re
import stat
import sys
import unicodedata
import zipfile
import zlib

MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_ENTRIES = 50_000
MAX_EXPANDED_BYTES = 1024 * 1024 * 1024
MAX_RATIO = 100

# Packaging noise skipped (never extracted): macOS resource forks and Finder files.
NOISE_TOP = "__MACOSX"
NOISE_NAME = ".DS_Store"
VCS = {".svn", ".git"}


class ArchiveError(Exception):
    pass


def _check_name(info: zipfile.ZipInfo) -> list:
    """Return the path components of a safe entry name, or raise."""
    raw = info.orig_filename
    if any(ord(c) < 0x20 or 0x7F <= ord(c) <= 0x9F for c in raw):
        raise ArchiveError("an entry name contains a control character")
    if raw != info.filename or "\\" in raw or raw.startswith("/") or re.match(r"[A-Za-z]:", raw):
        raise ArchiveError("an entry has an unsafe path")
    parts = (raw[:-1] if raw.endswith("/") else raw).split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ArchiveError("an entry has an unsafe path")
    return parts


def _check_type(info: zipfile.ZipInfo) -> None:
    if info.flag_bits & 0x1:
        raise ArchiveError("the archive has encrypted entries")
    kind = stat.S_IFMT(info.external_attr >> 16)
    if info.create_system == 3 and kind not in (0, stat.S_IFREG, stat.S_IFDIR):
        raise ArchiveError("an entry is not a regular file or directory")
    if kind == stat.S_IFDIR and not info.is_dir():
        raise ArchiveError("an entry is not a regular file or directory")


def _fold(parts) -> tuple:
    return tuple(unicodedata.normalize("NFC", part).casefold() for part in parts)


def inspect(zf: zipfile.ZipFile, archive_bytes: int) -> list:
    """Validate every entry; return (info, parts) for the entries to extract."""
    infos = zf.infolist()
    if len(infos) > MAX_ENTRIES:
        raise ArchiveError(f"the archive has more than {MAX_ENTRIES} entries")

    kept, raw_names, kinds, spellings, total = [], set(), {}, {}, 0
    for info in infos:
        parts = _check_name(info)
        _check_type(info)
        if info.orig_filename in raw_names:
            raise ArchiveError("the archive has a duplicate or ambiguous path")
        raw_names.add(info.orig_filename)
        if parts[0] == NOISE_TOP or parts[-1] == NOISE_NAME:
            continue
        if any(part.lower() in VCS for part in parts):
            raise ArchiveError("the archive contains version control metadata")

        # Every prefix is a directory; the last component is the entry itself.
        for depth in range(1, len(parts) + 1):
            kind = "file" if depth == len(parts) and not info.is_dir() else "dir"
            key, spelling = _fold(parts[:depth]), "/".join(parts[:depth])
            if key not in kinds:
                kinds[key], spellings[key] = kind, spelling
            elif spellings[key] != spelling:
                raise ArchiveError("the archive has a duplicate or ambiguous path")
            elif kind == "file" or kinds[key] == "file":
                raise ArchiveError("the archive has a file/directory conflict")

        total += info.file_size
        kept.append((info, parts))

    if total > MAX_EXPANDED_BYTES:
        raise ArchiveError(f"the archive expands past {MAX_EXPANDED_BYTES} bytes")
    if total > MAX_RATIO * max(archive_bytes, 1):
        raise ArchiveError(f"the archive's expansion ratio exceeds {MAX_RATIO}")
    return kept


def plugin_root(kept: list) -> tuple:
    """Path components of the plugin root: () when flat, (wrapper,) when wrapped."""
    top = {parts[0] for _, parts in kept}
    top_files = {parts[0] for info, parts in kept if len(parts) == 1 and not info.is_dir()}
    if "readme.txt" in top_files:
        return ()
    if len(top) == 1 and not top_files:
        wrapper = next(iter(top))
        if any(parts == [wrapper, "readme.txt"] and not info.is_dir() for info, parts in kept):
            return (wrapper,)
        raise ArchiveError("the plugin root has no readme.txt")
    raise ArchiveError(
        "cannot find one plugin root: readme.txt must be at the top level or inside one wrapper directory")


def extract(zip_path: str, dest: str) -> str:
    """Extract zip_path into the empty directory dest; return the plugin root."""
    size = os.path.getsize(zip_path)
    if size > MAX_ARCHIVE_BYTES:
        raise ArchiveError(f"the archive is larger than {MAX_ARCHIVE_BYTES} bytes")
    dest = os.path.realpath(dest)
    try:
        with zipfile.ZipFile(zip_path) as zf:
            kept = inspect(zf, size)
            root = plugin_root(kept)
            written = 0
            for info, parts in kept:
                target = os.path.join(dest, *parts)
                if not os.path.realpath(target).startswith(dest + os.sep):
                    raise ArchiveError("an entry has an unsafe path")
                if info.is_dir():
                    os.makedirs(target, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
                with zf.open(info) as source, os.fdopen(os.open(target, flags, 0o644), "wb") as out:
                    while True:
                        chunk = source.read(1024 * 1024)
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > MAX_EXPANDED_BYTES:
                            raise ArchiveError(f"the archive expands past {MAX_EXPANDED_BYTES} bytes")
                        out.write(chunk)
    except (zipfile.BadZipFile, zipfile.LargeZipFile, NotImplementedError, RuntimeError, EOFError,
            zlib.error, ValueError) as error:
        raise ArchiveError("the archive is malformed") from error
    return os.path.join(dest, *root)


def main(argv) -> int:
    if len(argv) != 3 or argv[0] != "extract":
        print(__doc__, file=sys.stderr)
        return 2
    try:
        print(extract(argv[1], argv[2]))
    except (ArchiveError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
