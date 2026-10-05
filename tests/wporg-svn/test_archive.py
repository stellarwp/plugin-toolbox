"""ZIP inspection, safe extraction and plugin root resolution."""

import os
import shutil
import stat
import tempfile
import unittest
import zipfile
from unittest import mock

import support  # noqa: F401  (puts lib/ on sys.path)

import archive

PLUGIN = {
    "readme.txt": "=== X ===\nStable tag: 1.1\n\nShort.\n",
    "fixture.php": "<?php\n/*\n * Plugin Name: X\n * Version: 1.1\n */\n",
}


def build_zip(path, entries):
    """entries: name -> bytes/str, or name -> ZipInfo-tweaking dict."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, value in entries.items():
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            data = value
            if isinstance(value, dict):
                data = value.get("data", b"")
                if "mode" in value:
                    info.external_attr = value["mode"] << 16
            if name.endswith("/"):
                info.external_attr = info.external_attr or (stat.S_IFDIR | 0o755) << 16
            zf.writestr(info, data.encode() if isinstance(data, str) else data)
    return path


def set_encrypted_flag(path):
    """Flip the 'encrypted' general purpose bit in every header."""
    with open(path, "r+b") as handle:
        blob = bytearray(handle.read())
        for signature, offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
            start = blob.find(signature)
            while start != -1:
                blob[start + offset] |= 0x01
                start = blob.find(signature, start + 4)
        handle.seek(0)
        handle.write(blob)


class ArchiveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.zip = os.path.join(self.tmp, "plugin.zip")
        self.dest = os.path.join(self.tmp, "out")
        os.mkdir(self.dest)

    def extract(self, entries):
        build_zip(self.zip, entries)
        return archive.extract(self.zip, self.dest)

    def assert_rejected(self, entries, message):
        with self.assertRaisesRegex(archive.ArchiveError, message):
            self.extract(entries)
        self.assertEqual(os.listdir(self.dest), [], "nothing may be extracted from a rejected archive")
        self.assertEqual(sorted(os.listdir(self.tmp)), ["out", "plugin.zip"], "nothing written outside")

    def read(self, *parts):
        with open(os.path.join(*parts), "rb") as handle:
            return handle.read()

    def test_flat_archive(self):
        entries = dict(PLUGIN)
        entries.update({".htaccess": "deny", "sub dir/a@b.txt": "x", "deep/er/empty.txt": "", "assets/": b""})
        root = self.extract(entries)
        self.assertEqual(root, self.dest)
        self.assertEqual(self.read(root, ".htaccess"), b"deny")
        self.assertEqual(self.read(root, "sub dir", "a@b.txt"), b"x")
        self.assertEqual(self.read(root, "deep", "er", "empty.txt"), b"")
        self.assertTrue(os.path.isdir(os.path.join(root, "assets")))

    def test_single_wrapper_directory_of_any_name(self):
        root = self.extract({"whatever-name/" + k: v for k, v in PLUGIN.items()})
        self.assertEqual(root, os.path.join(self.dest, "whatever-name"))
        self.assertEqual(self.read(root, "readme.txt"), PLUGIN["readme.txt"].encode())

    def test_ignores_documented_packaging_noise(self):
        entries = {"w/" + k: v for k, v in PLUGIN.items()}
        entries.update({"__MACOSX/w/._readme.txt": "junk", "w/.DS_Store": "junk", ".DS_Store": "junk"})
        root = self.extract(entries)
        self.assertEqual(root, os.path.join(self.dest, "w"))
        self.assertEqual(sorted(os.listdir(self.dest)), ["w"])
        self.assertNotIn(".DS_Store", os.listdir(root))

    def test_rejects_multiple_roots(self):
        entries = {"a/" + k: v for k, v in PLUGIN.items()}
        entries.update({"b/" + k: v for k, v in PLUGIN.items()})
        self.assert_rejected(entries, "plugin root")

    def test_rejects_deep_wrappers(self):
        self.assert_rejected({"a/b/" + k: v for k, v in PLUGIN.items()}, "readme.txt")

    def test_rejects_unrelated_siblings_of_a_wrapper(self):
        entries = {"w/" + k: v for k, v in PLUGIN.items()}
        entries["LICENSE"] = "gpl"
        self.assert_rejected(entries, "plugin root")

    def test_rejects_missing_readme(self):
        self.assert_rejected({"fixture.php": PLUGIN["fixture.php"]}, "plugin root")

    def test_rejects_readme_directory(self):
        self.assert_rejected({"readme.txt/x": "x", "fixture.php": "x"}, "plugin root")

    def test_rejects_traversal_and_absolute_paths(self):
        for name in ("../evil.php", "a/../../evil.php", "/abs/evil.php", "C:/evil.php", "a\\..\\evil.php",
                     "a/./b.php", "a//b.php", "./b.php"):
            with self.subTest(name=name):
                entries = dict(PLUGIN)
                entries[name] = "x"
                self.assert_rejected(entries, "unsafe path")

    def test_rejects_control_characters(self):
        for name in ("a\nb.txt", "a\x7fb.txt", "a\x1bb.txt", "a\x85b.txt"):
            with self.subTest(name=repr(name)):
                entries = dict(PLUGIN)
                entries[name] = "x"
                self.assert_rejected(entries, "control character")

    def test_rejects_nul_in_names(self):
        # zipfile truncates names at NUL when writing, so patch the raw bytes.
        entries = dict(PLUGIN)
        entries["evil.php#.txt"] = "x"
        build_zip(self.zip, entries)
        with open(self.zip, "r+b") as handle:
            blob = handle.read().replace(b"evil.php#.txt", b"evil.php\0.txt")
            handle.seek(0)
            handle.write(blob)
        with self.assertRaisesRegex(archive.ArchiveError, "control character"):
            archive.extract(self.zip, self.dest)
        self.assertEqual(os.listdir(self.dest), [])

    def test_rejects_duplicates_and_ambiguous_spellings(self):
        pairs = [
            ("README.TXT", "readme.txt"),
            ("Dir/a.txt", "dir/b.txt"),
            ("caf\u00e9.txt", "cafe\u0301.txt"),
            ("a", "a/b.txt"),
        ]
        for first, second in pairs:
            with self.subTest(first=first, second=second):
                entries = dict(PLUGIN)
                entries[first] = "1"
                entries[second] = "2"
                self.assert_rejected(entries, "duplicate|conflict")

    def test_rejects_exact_duplicate_entries(self):
        build_zip(self.zip, PLUGIN)
        with zipfile.ZipFile(self.zip, "a") as zf, self.assertWarns(UserWarning):
            zf.writestr("readme.txt", "again")
        with self.assertRaisesRegex(archive.ArchiveError, "duplicate"):
            archive.extract(self.zip, self.dest)

    def test_rejects_symlinks_and_special_files(self):
        for kind in (stat.S_IFLNK, stat.S_IFIFO, stat.S_IFCHR, stat.S_IFBLK, stat.S_IFSOCK):
            with self.subTest(kind=kind):
                entries = dict(PLUGIN)
                entries["link"] = {"data": "/etc/passwd", "mode": kind | 0o777}
                self.assert_rejected(entries, "not a regular file")

    def test_rejects_vcs_metadata(self):
        for name in (".svn/entries", "w/.git/config", ".git", "x/.SVN/wc.db"):
            with self.subTest(name=name):
                entries = dict(PLUGIN)
                entries[name] = "x"
                self.assert_rejected(entries, "version control")

    def test_keeps_vcs_lookalikes(self):
        entries = dict(PLUGIN)
        entries.update({".gitignore": "x", ".svnignore": "y", "git/x": "z"})
        root = self.extract(entries)
        self.assertEqual(self.read(root, ".gitignore"), b"x")

    def test_rejects_encrypted_entries(self):
        build_zip(self.zip, PLUGIN)
        set_encrypted_flag(self.zip)
        with self.assertRaisesRegex(archive.ArchiveError, "encrypted"):
            archive.extract(self.zip, self.dest)
        self.assertEqual(os.listdir(self.dest), [])

    def test_rejects_malformed_archives(self):
        with open(self.zip, "wb") as handle:
            handle.write(b"this is not a zip file at all")
        with self.assertRaisesRegex(archive.ArchiveError, "malformed"):
            archive.extract(self.zip, self.dest)

    def test_rejects_truncated_archives(self):
        build_zip(self.zip, PLUGIN)
        with open(self.zip, "r+b") as handle:
            handle.truncate(os.path.getsize(self.zip) // 2)
        with self.assertRaisesRegex(archive.ArchiveError, "malformed"):
            archive.extract(self.zip, self.dest)

    def test_rejects_corrupt_content(self):
        with zipfile.ZipFile(self.zip, "w", zipfile.ZIP_STORED) as zf:
            for name, data in PLUGIN.items():
                zf.writestr(name, data)
        with open(self.zip, "r+b") as handle:
            blob = bytearray(handle.read())
            at = blob.find(b"Stable tag")
            blob[at] ^= 0xFF
            handle.seek(0)
            handle.write(blob)
        with self.assertRaisesRegex(archive.ArchiveError, "malformed"):
            archive.extract(self.zip, self.dest)

    def test_entry_count_limit(self):
        entries = dict(PLUGIN)
        entries.update({f"f{i}.txt": "x" for i in range(5)})
        with mock.patch.object(archive, "MAX_ENTRIES", 6):
            self.assert_rejected(entries, "entries")

    def test_expanded_size_limit(self):
        entries = dict(PLUGIN)
        entries["big.bin"] = os.urandom(4096)
        with mock.patch.object(archive, "MAX_EXPANDED_BYTES", 4096):
            self.assert_rejected(entries, "expands")

    def test_expansion_ratio_limit(self):
        entries = dict(PLUGIN)
        entries["zeros.bin"] = b"\0" * (1024 * 1024)
        self.assert_rejected(entries, "ratio")

    def test_archive_size_limit(self):
        build_zip(self.zip, PLUGIN)
        with mock.patch.object(archive, "MAX_ARCHIVE_BYTES", 10):
            with self.assertRaisesRegex(archive.ArchiveError, "larger"):
                archive.extract(self.zip, self.dest)


if __name__ == "__main__":
    unittest.main()
