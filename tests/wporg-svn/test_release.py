"""Version, readme Stable Tag and plugin header parsing."""

import tempfile
import unittest

from support import write

import release

README = """=== Fixture Plugin ===
Contributors: someone
Tags: events
Requires at least: 6.0
Tested up to: 6.6
Stable tag: {stable}
License: GPLv2

A short description.

== Changelog ==

= 1.0 =
* Stable tag: 9.9 is only an example in the body.
"""

PLUGIN = """<?php
/**
 * Plugin Name: Fixture Plugin
 * Description: Test fixture.
 * Version: {version}
 */
"""


class VersionTest(unittest.TestCase):
    def test_accepts_numeric_dotted_versions(self):
        for good in ("0", "1", "1.2", "1.2.3.4", "01.2", "99999999999999999999.1"):
            with self.subTest(good=good):
                self.assertTrue(release.is_version(good))

    def test_rejects_everything_else(self):
        bad = ("", " ", "trunk", "v1.2", "1.2-beta", "1..2", ".1", "1.", "1.2 ", " 1.2",
               "1.2\n", "١.٢", "1,2", "1.2a", "+1", "1.2/3", "1e3")
        for value in bad:
            with self.subTest(value=value):
                self.assertFalse(release.is_version(value))

    def test_compares_components_as_integers(self):
        cases = [
            ("1.10", "1.9", 1),
            ("1.9", "1.10", -1),
            ("1.2", "1.2.0", 0),
            ("01.2", "1.2", 0),
            ("1.2.0.1", "1.2", 1),
            ("2", "1.99.99", 1),
            ("99999999999999999999.1", "99999999999999999999", 1),
            ("10", "9.9999", 1),
        ]
        for left, right, expected in cases:
            with self.subTest(left=left, right=right):
                self.assertEqual(release.compare(left, right), expected)

    def test_compare_refuses_invalid_versions(self):
        with self.assertRaises(release.ReleaseError):
            release.compare("1.2-beta", "1.2")

    def test_equivalents_finds_other_spellings_of_a_version(self):
        names = ["1.2", "1.2.0", "01.2", "1.3", "trunk-copy", "1.2-beta"]
        self.assertEqual(release.equivalents("1.2", names), ["1.2", "1.2.0", "01.2"])


class StableTagTest(unittest.TestCase):
    def parse(self, text):
        return release.stable_tag(text.encode() if isinstance(text, str) else text)

    def test_reads_the_header_field(self):
        self.assertEqual(self.parse(README.format(stable="1.2.3")), "1.2.3")

    def test_ignores_examples_in_the_body(self):
        # The body's "Stable tag: 9.9" must not count as a second field.
        self.assertEqual(self.parse(README.format(stable="1.0")), "1.0")

    def test_handles_crlf_bom_case_and_whitespace(self):
        text = "﻿=== X ===\r\nContributors: a\r\nSTABLE TAG:   2.0.1   \r\n\r\nShort.\r\n"
        self.assertEqual(self.parse(text), "2.0.1")

    def test_handles_cr_only_line_endings(self):
        self.assertEqual(self.parse("=== X ===\rStable tag: 3.1\r\rShort.\r"), "3.1")

    def test_allows_blank_lines_inside_the_header(self):
        self.assertEqual(self.parse("=== X ===\nContributors: a\n\nStable tag: 1.4\n\nShort.\n"), "1.4")

    def test_header_ends_at_the_short_description(self):
        text = "=== X ===\nContributors: a\n\nShort description.\n\nStable tag: 1.4\n"
        with self.assertRaisesRegex(release.ReleaseError, "no Stable Tag"):
            self.parse(text)

    def test_unknown_field_after_blank_line_ends_the_header(self):
        text = "=== X ===\nContributors: a\n\nNote: hi\nStable tag: 1.4\n"
        with self.assertRaisesRegex(release.ReleaseError, "no Stable Tag"):
            self.parse(text)

    def test_readme_without_title_line(self):
        self.assertEqual(self.parse("Stable tag: 1.5\nLicense: GPL\n\nShort.\n"), "1.5")

    def test_github_style_title_underline(self):
        self.assertEqual(self.parse("Fixture\n=======\nStable tag: 1.6\n\nShort.\n"), "1.6")

    def test_bulleted_field(self):
        self.assertEqual(self.parse("=== X ===\n* Stable tag: 1.7\n\nShort.\n"), "1.7")

    def test_rejects_duplicate_fields(self):
        text = "=== X ===\nStable tag: 1.2\nstable tag: 1.3\n\nShort.\n"
        with self.assertRaisesRegex(release.ReleaseError, "2 Stable Tag"):
            self.parse(text)

    def test_rejects_missing_field(self):
        with self.assertRaisesRegex(release.ReleaseError, "no Stable Tag"):
            self.parse("=== X ===\nContributors: a\n\nShort.\n")

    def test_never_truncates_an_invalid_suffix(self):
        self.assertEqual(self.parse(README.format(stable="1.2-beta")), "1.2-beta")
        self.assertEqual(self.parse(README.format(stable="1.2-")), "1.2-")

    def test_returns_non_numeric_values_for_the_caller_to_reject(self):
        self.assertEqual(self.parse(README.format(stable="trunk")), "trunk")

    def test_rejects_utf16(self):
        with self.assertRaisesRegex(release.ReleaseError, "UTF-16"):
            self.parse("Stable tag: 1.0\n".encode("utf-16"))


class PluginVersionTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(__import__("shutil").rmtree, self.root)

    def version(self):
        return release.plugin_version(self.root)

    def test_reads_the_version_header(self):
        write(self.root, "fixture.php", PLUGIN.format(version="1.2.3"))
        self.assertEqual(self.version(), "1.2.3")

    def test_any_root_php_filename_works(self):
        write(self.root, "some-other-name.php", PLUGIN.format(version="2.0"))
        write(self.root, "uninstall.php", "<?php\n// nothing\n")
        self.assertEqual(self.version(), "2.0")

    def test_only_root_level_files_count(self):
        write(self.root, "src/fixture.php", PLUGIN.format(version="1.0"))
        with self.assertRaisesRegex(release.ReleaseError, "no root PHP file"):
            self.version()

    def test_rejects_two_plugin_files(self):
        write(self.root, "a.php", PLUGIN.format(version="1.0"))
        write(self.root, "b.php", PLUGIN.format(version="1.0"))
        with self.assertRaisesRegex(release.ReleaseError, "2 root PHP files"):
            self.version()

    def test_rejects_duplicate_version_headers(self):
        write(self.root, "a.php", PLUGIN.format(version="1.0") + " * Version: 1.1\n")
        with self.assertRaisesRegex(release.ReleaseError, "2 Version headers"):
            self.version()

    def test_rejects_duplicate_plugin_name_headers(self):
        write(self.root, "a.php", PLUGIN.format(version="1.0") + " * Plugin Name: Other\n")
        with self.assertRaisesRegex(release.ReleaseError, "2 Plugin Name headers"):
            self.version()

    def test_rejects_missing_or_empty_version(self):
        write(self.root, "a.php", "<?php\n/*\n * Plugin Name: X\n * Version:   \n */\n")
        with self.assertRaisesRegex(release.ReleaseError, "no Version header"):
            self.version()

    def test_rejects_invalid_version(self):
        write(self.root, "a.php", PLUGIN.format(version="1.2-beta"))
        with self.assertRaisesRegex(release.ReleaseError, "not a numeric version"):
            self.version()

    def test_only_reads_the_first_8_kib(self):
        padding = "<?php\n/*\n * Plugin Name: X\n" + " *\n" * 4096
        write(self.root, "a.php", padding + " * Version: 1.0\n */\n")
        with self.assertRaisesRegex(release.ReleaseError, "no Version header"):
            self.version()

    def test_a_duplicate_past_8_kib_is_invisible(self):
        text = PLUGIN.format(version="1.0") + "//" + "x" * 9000 + "\n * Version: 2.0\n"
        write(self.root, "a.php", text)
        self.assertEqual(self.version(), "1.0")

    def test_strips_comment_terminators(self):
        write(self.root, "a.php", "<?php /* Plugin Name: X\nVersion: 1.4 */\n")
        self.assertEqual(self.version(), "1.4")

    def test_handles_bom_and_cr_only_endings(self):
        write(self.root, "a.php", b"\xef\xbb\xbf<?php\r/*\r * Plugin Name: X\r * Version: 1.5\r */\r")
        self.assertEqual(self.version(), "1.5")

    def test_empty_plugin_name_is_not_a_plugin(self):
        write(self.root, "a.php", PLUGIN.format(version="1.0"))
        write(self.root, "b.php", "<?php\n/*\n * Plugin Name:\n * Version: 9\n */\n")
        write(self.root, "c.php", "<?php\n/*\n * Plugin Name: 0\n * Version: 9\n */\n")
        self.assertEqual(self.version(), "1.0")

    def test_ignores_non_php_and_directories_named_like_php(self):
        write(self.root, "a.php", PLUGIN.format(version="1.0"))
        write(self.root, "B.PHP", PLUGIN.format(version="9.0"))
        write(self.root, "dir.php/x.txt", "x")
        self.assertEqual(self.version(), "1.0")


if __name__ == "__main__":
    unittest.main()
