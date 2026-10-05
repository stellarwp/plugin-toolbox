"""svndump.py: find byte-changing properties in a real svnrdump stream, and never pass one it cannot read."""

import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import support

sys.path.insert(0, support.LIB)

import svndump  # noqa: E402

TREE = {
    "readme.txt": "=== Fixture ===\n",
    # Content that looks like dump syntax must be skipped by length, never parsed.
    "lang/data.mo": b"\x00\xffPROPS-END\nNode-path: fake\nNode-action: delete\nK 12\nsvn:keywords\n" * 40,
    "src/a.php": "<?php\n",
    "src/b.php": "<?php\n",
    "café/résumé.txt": "non-ASCII names",
    "empty/": None,
}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        os.makedirs(os.path.join(self.tmp, "home"))
        self.env = support.base_env(os.path.join(self.tmp, "home"))
        self.repo = support.Repo(self.tmp, self.env)
        self.repo.put_tree("trunk-new", TREE)
        self.repo.mucc("rm", self.repo.url("trunk"), "mv", self.repo.url("trunk-new"), self.repo.url("trunk"))
        value = support.write(self.repo.staging, "binary-value", b"\x00\xff\nPROPS-END\nK 3\nabc\n")
        self.repo.mucc("propset", "svn:mime-type", "application/octet-stream", self.repo.url("trunk/lang/data.mo"),
                       "propset", "svn:executable", "*", self.repo.url("trunk/src/a.php"),
                       "propset", "svn:ignore", "one\nPROPS-END\nV 3\n\ntwo\n", self.repo.url("trunk/src"),
                       "propsetf", "fixture:binary", value, self.repo.url("trunk/café"))
        self.tag()

    def tag(self):
        """Make tags/1.0 a server-side copy of trunk, as wordpress.org tags usually are."""
        actions = ["rm", self.repo.url("tags/1.0")] if self.repo.exists("tags/1.0") else []
        self.repo.mucc(*actions, "cp", "HEAD", self.repo.url("trunk"), self.repo.url("tags/1.0"))
        self.repo.mucc("mkdir", self.repo.url("unrelated-" + str(self.repo.head())))  # R is not the copy's revision

    def dump(self):
        return subprocess.run(["svnrdump", "dump", "--quiet", "-r", str(self.repo.head()), "--",
                               self.repo.url("tags/1.0")], env=self.env, capture_output=True, check=True).stdout

    def check(self, data):
        return svndump.check(io.BytesIO(data))


class CheckTest(Base):
    def test_finds_every_property_in_a_real_dump(self):
        found = svndump.properties(io.BytesIO(self.dump()))
        tag = f"{support.SLUG}/tags/1.0"
        self.assertEqual(found, {
            (f"{tag}/lang/data.mo", "svn:mime-type"), (f"{tag}/src/a.php", "svn:executable"),
            (f"{tag}/src", "svn:ignore"), (f"{tag}/café", "fixture:binary"),
        })

    def test_a_tag_without_byte_changing_properties_passes(self):
        self.assertEqual(self.check(self.dump()), {})

    def test_byte_changing_properties_are_counted(self):
        for prop, targets, value in (
            ("svn:keywords", ["src/a.php", "src/b.php"], "Id"),
            ("svn:eol-style", ["readme.txt"], "native"),
            ("svn:special", ["src/b.php"], "*"),
            ("svn:externals", [""], "lib https://example.invalid/lib"),  # the tag's own root
        ):
            with self.subTest(prop=prop):
                actions = []
                for target in targets:
                    actions += ["propset", prop, value, self.repo.url("trunk/" + target).rstrip("/")]
                self.repo.mucc(*actions)
                self.tag()
                self.assertEqual(self.check(self.dump()), {prop: len(targets)})
                self.repo.mucc(*[a if a != "propset" else "propdel" for a in actions if a != value])


class UnreadableTest(Base):
    def assert_unreadable(self, data):
        with self.assertRaises(svndump.DumpError):
            self.check(data)

    def test_every_cut_inside_a_record_is_unreadable(self):
        # Completeness itself comes from svnrdump's exit status: a stream cut
        # exactly between two records looks whole, so those cuts are skipped.
        self.repo.mucc("propset", "svn:keywords", "Id", self.repo.url("trunk/src/a.php"))
        self.tag()
        data = self.dump()
        for cut in range(len(data)):
            tail = data[cut:].lstrip(b"\n")
            if not tail or tail.startswith(b"Node-path: "):
                continue
            with self.subTest(cut=cut):
                self.assert_unreadable(data[:cut])

    def test_records_it_cannot_account_for_are_unreadable(self):
        data = self.dump()
        node = b"Node-path: " + f"{support.SLUG}/tags/1.0/readme.txt".encode() + b"\n"
        deletion = b"D 12\nsvn:keywords\nPROPS-END\n"
        self.assertIn(node, data)
        for name, changed in (
            ("no paths", data[:data.index(b"Node-path: ")]),
            ("format version", data.replace(b"SVN-fs-dump-format-version: 3", b"SVN-fs-dump-format-version: 4")),
            ("change action", data.replace(node + b"Node-kind: file\nNode-action: add",
                                           node + b"Node-kind: file\nNode-action: change")),
            ("copy source", data.replace(node, node + b"Node-copyfrom-rev: 1\nNode-copyfrom-path: trunk/readme.txt\n")),
            ("header line", data.replace(node, node + b"not a header\n")),
            ("non-numeric length", data.replace(b"Prop-content-length: 10\n", b"Prop-content-length: ten\n", 1)),
            ("lengths disagree", data.replace(b"Content-length: 10\n", b"Content-length: 11\n", 1)),
            ("property deletion", data.replace(b"Prop-content-length: 10\nContent-length: 10\n\nPROPS-END\n",
                                               b"Prop-content-length: %d\nContent-length: %d\n\n%s"
                                               % (len(deletion), len(deletion), deletion), 1)),
            ("not utf-8 path", data.replace(node, b"Node-path: \xff\n")),
        ):
            with self.subTest(name=name):
                self.assertNotEqual(changed, data)
                self.assert_unreadable(changed)


class CommandTest(Base):
    def run_check(self, data):
        return subprocess.run([sys.executable, os.path.join(support.LIB, "svndump.py"), "check-props"],
                              input=data, capture_output=True)

    def test_exit_codes(self):
        self.assertEqual(self.run_check(self.dump()).returncode, 0)
        self.assertEqual(self.run_check(b"").returncode, 3)
        self.repo.mucc("propset", "svn:keywords", "Id", self.repo.url("trunk/src/a.php"))
        self.tag()
        failed = self.run_check(self.dump())
        self.assertEqual(failed.returncode, 1)
        self.assertIn(b"error: 1 path(s) set svn:keywords", failed.stderr)

    def test_reads_to_the_end_even_when_unreadable(self):
        # svnrdump must never be cut off by a closed pipe: its own exit status
        # is how the caller tells a failed read from an unreadable stream.
        parser = subprocess.Popen([sys.executable, os.path.join(support.LIB, "svndump.py"), "check-props"],
                                  stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            parser.stdin.write(b"garbage\n\n" + b"x" * (8 * 1024 * 1024))
            parser.stdin.close()
        finally:
            parser.wait(timeout=60)
        self.assertEqual(parser.returncode, 3)


if __name__ == "__main__":
    unittest.main()
