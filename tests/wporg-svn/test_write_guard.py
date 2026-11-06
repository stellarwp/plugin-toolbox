"""The test-only write guard: no test or QA run may write to a non-file:// repository."""

import os
import subprocess
import sys
import tempfile
import unittest

import support

sys.path.insert(0, os.path.join(support.TESTS, "guard"))

import write_guard  # noqa: E402

REMOTE = "https://plugins.svn.wordpress.org.invalid/fixture-plugin"  # .invalid never resolves
LOCAL = "file:///tmp/repo/fixture-plugin"


def root_of(remote):
    return lambda path: REMOTE if remote else LOCAL


class RefusalTest(unittest.TestCase):
    def refused(self, tool, *args, remote_wc=False):
        return write_guard.refusal(tool, list(args), root_of(remote_wc)) is not None

    def test_svnmucc_only_writes_to_file_urls(self):
        self.assertTrue(self.refused("svnmucc", "-m", "x", "mkdir", REMOTE + "/tags/1.0"))
        self.assertTrue(self.refused("svnmucc", "-U", REMOTE, "-m", "x", "rm", "trunk"))
        self.assertTrue(self.refused("svnmucc", "-m", "x", "rm", "trunk"))
        self.assertTrue(self.refused("svnmucc", "cp", "1", LOCAL + "/a", "svn://example.invalid/b"))
        self.assertFalse(self.refused("svnmucc", "-m", "x", "cp", "3", LOCAL + "/tags/1", LOCAL + "/tags/2"))

    def test_svnrdump_only_loads_into_file_urls(self):
        self.assertTrue(self.refused("svnrdump", "load", REMOTE))
        self.assertTrue(self.refused("svnrdump", "--non-interactive", "--config-dir", "/tmp/c", "load", "--", REMOTE))
        self.assertTrue(self.refused("svnrdump", "load"))
        self.assertFalse(self.refused("svnrdump", "load", LOCAL))
        self.assertFalse(self.refused("svnrdump", "dump", "--quiet", "-r", "5", "--", REMOTE + "/tags/1.0"))

    def test_svn_url_writes_to_remote_repositories_are_refused(self):
        for args in (
            ["mkdir", "-m", "x", REMOTE + "/tags/9"],
            ["rm", "-m", "x", REMOTE + "/trunk"],
            ["copy", "-m", "x", REMOTE + "/trunk", REMOTE + "/tags/9"],
            ["import", "-m", "x", ".", REMOTE + "/trunk"],
            ["propset", "--revprop", "-r", "5", "svn:log", "x", REMOTE],
            ["--non-interactive", "--config-dir", "/tmp/c", "move", "-m", "x", REMOTE + "/a", REMOTE + "/b"],
            ["mkdir", "-m", "x", "http://plugins.svn.wordpress.org.invalid/x"],
        ):
            with self.subTest(args=args):
                self.assertTrue(self.refused("svn", *args))

    def test_svn_working_copy_writes_check_the_repository_root(self):
        for args in (["commit", "-m", "x"], ["ci", "-m", "x", "wc"], ["lock", "wc/f"], ["unlock", "wc/f"],
                     ["--config-dir", "/tmp/c", "commit", "-m", "x", "wc"], ["rm", "wc/f"],
                     ["propset", "p", "v", "wc/f"]):
            with self.subTest(args=args):
                self.assertTrue(self.refused("svn", *args, remote_wc=True))
                self.assertFalse(self.refused("svn", *args, remote_wc=False))

    def test_reads_and_local_operations_pass(self):
        for args in (["cat", REMOTE + "/trunk/readme.txt"], ["list", "--xml", REMOTE + "/tags"],
                     ["info", "--show-item", "revision", REMOTE], ["log", "-v", REMOTE],
                     ["export", REMOTE + "/tags/1.0", "/tmp/x"], ["checkout", REMOTE + "/trunk", "/tmp/wc"],
                     ["diff", "--summarize", REMOTE + "/a", REMOTE + "/b"], ["proplist", "-R", REMOTE],
                     ["add", "wc/new"], ["status", "--xml", "wc"], ["update", "wc"], ["--version", "--quiet"]):
            with self.subTest(args=args):
                self.assertFalse(self.refused("svn", *args, remote_wc=True))


class ShimTest(unittest.TestCase):
    """The shims on PATH really stop the command before it reaches svn."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(__import__("shutil").rmtree, self.tmp)
        self.env = support.base_env(self.tmp)

    def run_shim(self, *argv):
        return subprocess.run(list(argv), env=self.env, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                              timeout=60)

    def test_remote_writes_never_reach_svn(self):
        for argv in (["svnmucc", "--non-interactive", "-m", "x", "mkdir", REMOTE + "/tags/9"],
                     ["svn", "--non-interactive", "mkdir", "-m", "x", REMOTE + "/tags/9"],
                     ["svnrdump", "--non-interactive", "load", REMOTE]):
            with self.subTest(argv=argv):
                result = self.run_shim(*argv)
                self.assertEqual(result.returncode, 99, result.stderr)
                self.assertIn("write-guard: refused", result.stderr)

    def test_local_writes_and_reads_pass_through(self):
        repo = os.path.join(self.tmp, "repo")
        subprocess.run(["svnadmin", "create", repo], check=True)
        url = "file://" + repo
        self.assertEqual(self.run_shim("svnmucc", "-m", "x", "mkdir", url + "/a").returncode, 0)
        self.assertEqual(self.run_shim("svn", "mkdir", "-m", "x", url + "/b").returncode, 0)
        listing = self.run_shim("svn", "list", url)
        self.assertEqual(listing.stdout.split(), ["a/", "b/"])

    def test_shims_are_first_on_the_test_path(self):
        for tool in ("svn", "svnmucc", "svnrdump"):
            found = subprocess.run(["sh", "-c", f"command -v {tool}"], env=self.env, capture_output=True, text=True)
            self.assertEqual(os.path.dirname(found.stdout.strip()), support.GUARD_BIN)


if __name__ == "__main__":
    unittest.main()
