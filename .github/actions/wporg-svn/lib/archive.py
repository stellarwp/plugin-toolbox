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
import struct
import sys
import unicodedata
import zipfile
import zlib

MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_ENTRIES = 50_000
MAX_EXPANDED_BYTES = 1024 * 1024 * 1024
MAX_RATIO = 100
MAX_DEPTH = 64
MAX_PATH_BYTES = 1024

# Packaging noise skipped (never extracted): macOS resource forks and Finder files.
NOISE_TOP = "__MACOSX"
NOISE_NAME = ".DS_Store"
VCS = {".svn", ".git"}


class ArchiveError(Exception):
    pass


def _check_control(name: str) -> None:
    if any(ord(c) < 0x20 or 0x7F <= ord(c) <= 0x9F for c in name):
        raise ArchiveError("an entry name contains a control character")


def _unicode_paths(info: zipfile.ZipInfo, header: bytes):
    """Yield the name in each of the entry's Info-ZIP Unicode Path fields (0x7075).

    Only version 1 fields whose CRC matches the header name count; any other is
    stale, as unzip and zipfile treat it.
    """
    extra, header_crc = info.extra, zlib.crc32(header)
    while len(extra) >= 4:
        kind, size = struct.unpack("<HH", extra[:4])
        data, extra = extra[4:4 + size], extra[4 + size:]
        if kind != 0x7075:
            continue
        if len(data) < 5:
            raise ArchiveError("the archive is malformed")
        version, crc = struct.unpack("<BI", data[:5])
        if version == 1 and crc == header_crc:
            try:
                yield data[5:].decode("utf-8")
            except UnicodeDecodeError:
                raise ArchiveError("an entry name is not UTF-8") from None


def _name(info: zipfile.ZipInfo) -> str:
    """The entry's name as its author wrote it.

    zipfile reads a name without the UTF-8 flag as CP437, but Info-ZIP's zip
    (macOS, Ubuntu) writes UTF-8 there without setting the flag. Such names are
    taken as UTF-8; one that isn't valid UTF-8 is refused rather than guessed.
    """
    raw = info.orig_filename
    _check_control(raw)
    flagged = info.flag_bits & 0x800
    name = raw
    if not flagged and not raw.isascii():
        try:
            name = raw.encode("cp437").decode("utf-8")
        except UnicodeError:
            raise ArchiveError("an entry name is not UTF-8") from None
        _check_control(name)
    # unzip and zipfile 3.12+ take the name from the last valid Unicode Path
    # field; older zipfile ignores them. Every one must agree, on every Python.
    if any(other != name for other in _unicode_paths(info, raw.encode("utf-8" if flagged else "cp437"))):
        raise ArchiveError("an entry has two different names")
    # Otherwise filename differs from both only where zipfile changed the name.
    if info.filename not in (raw, name):
        raise ArchiveError("an entry has an unsafe path")
    return name


def _check_name(info: zipfile.ZipInfo) -> list:
    """Return the path components of a safe entry name, or raise."""
    name = _name(info)
    if "\\" in name or name.startswith("/") or re.match(r"[A-Za-z]:", name):
        raise ArchiveError("an entry has an unsafe path")
    if len(name.encode()) > MAX_PATH_BYTES:
        raise ArchiveError(f"an entry path is longer than {MAX_PATH_BYTES} bytes")
    parts = (name[:-1] if name.endswith("/") else name).split("/")
    if len(parts) > MAX_DEPTH:
        raise ArchiveError(f"an entry path is deeper than {MAX_DEPTH} levels")
    if any(part in ("", ".", "..") for part in parts):
        raise ArchiveError("an entry has an unsafe path")
    return parts


def _check_type(info: zipfile.ZipInfo) -> None:
    if info.flag_bits & 0x1:
        raise ArchiveError("the archive has encrypted entries")
    kind = stat.S_IFMT(info.external_attr >> 16)
    # Hosts that store Unix modes: 3 is Unix, 19 is OS X.
    if info.create_system in (3, 19) and kind not in (0, stat.S_IFREG, stat.S_IFDIR):
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
        # Each distinct one becomes a file or directory on disk, listed or not.
        folded = _fold(parts)
        for depth in range(1, len(parts) + 1):
            kind = "file" if depth == len(parts) and not info.is_dir() else "dir"
            key, spelling = folded[:depth], "/".join(parts[:depth])
            if key not in kinds:
                kinds[key], spellings[key] = kind, spelling
                if len(kinds) > MAX_ENTRIES:
                    raise ArchiveError(f"the archive has more than {MAX_ENTRIES} files and directories")
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
