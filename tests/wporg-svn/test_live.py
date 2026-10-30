"""Read-only checks against real wordpress.org plugins. Opt-in: WPORG_LIVE=1.

Nothing here writes to wordpress.org. The read helpers never write, every write
in the mirror test goes to a local file:// repository, and the write guard is
first on PATH for all of it.

  WPORG_LIVE=1 python3 -m unittest discover -s tests/wporg-svn -p test_live.py -v
  WPORG_LIVE_PLUGINS  plugins for the read checks (comma-separated)
  WPORG_LIVE_MIRROR   plugins for the mirror release (comma-separated)
"""

import os
import shutil
import subprocess
import tempfile
import time
import unittest

from support import TESTS, ActionTest, Repo, base_env, read_tree  # first: puts lib/ on sys.path

import archive  # noqa: E402
import release  # noqa: E402

LIVE = os.environ.get("WPORG_LIVE") == "1"
PLUGINS = os.environ.get("WPORG_LIVE_PLUGINS", "the-events-calendar,event-tickets,kadence-blocks,give").split(",")
MIRROR = os.environ.get("WPORG_LIVE_MIRROR", "image-widget,advanced-post-manager,the-events-calendar").split(",")
SVN_ROOT = "https://plugins.svn.wordpress.org"


def zip_url(slug, version):
    return f"https://downloads.wordpress.org/plugin/{slug}.{version}.zip"


@unittest.skipUnless(LIVE, "set WPORG_LIVE=1 to read from wordpress.org")
class LiveReadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env = dict(base_env(self.tmp), TMPDIR=self.tmp)

    cache = {}

    def read(self, slug):
        """Run the read harness once per plugin."""
        if slug not in self.cache:
            started = time.time()
            result = subprocess.run(["bash", os.path.join(TESTS, "live_reads.sh"), slug], env=self.env,
                                    capture_output=True, text=True, timeout=1200)
            seen = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
            self.cache[slug] = (result, seen, time.time() - started)
        return self.cache[slug][:2]

    def test_read_helpers_against_real_plugins(self):
        for slug in PLUGINS:
            with self.subTest(slug=slug):
                result, seen = self.read(slug)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertTrue(seen["revision"].isdigit())
                self.assertEqual(seen["trunk-readme"], "file")
                self.assertEqual(seen["stable-kind"], "dir")
                self.assertEqual(seen["probe-kind"], "absent")
                self.assertIn(seen["stable"], seen["tags"].split(","))
                print(f"\n  {slug}: r{seen['revision']} stable {seen['stable']} "
                      f"({len(seen['tags'].split(','))} tags), read helpers took {self.cache[slug][2]:.0f}s")

    def test_a_missing_plugin_is_an_error_not_an_absence(self):
        result, seen = self.read("zz-no-such-plugin-0000")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("revision", seen)
        self.assertRegex(result.stdout, r"SVN read failed while reading zz-no-such-plugin-0000: \w")
        print("\n  " + [line for line in result.stdout.splitlines() if "SVN read failed" in line][0])

    def test_parsers_on_real_release_zips(self):
        for slug in PLUGINS:
            with self.subTest(slug=slug):
                _, seen = self.read(slug)
                stable, folder = seen["stable"], tempfile.mkdtemp(dir=self.tmp)
                path = os.path.join(folder, "release.zip")
                subprocess.run(["curl", "-q", "-fsSL", "--proto", "=https", "-o", path, zip_url(slug, stable)],
                               check=True, timeout=600)
                os.mkdir(os.path.join(folder, "out"))
                root = archive.extract(path, os.path.join(folder, "out"))
                self.assertEqual(release.plugin_version(root), stable)
                with open(os.path.join(root, "readme.txt"), "rb") as handle:
                    self.assertEqual(release.stable_tag(handle.read()), stable)
                files = sum(len(names) for _, _, names in os.walk(root))
                print(f"\n  {slug} {stable}: {os.path.getsize(path)} bytes zipped, {files} files, "
                      f"wrapper {os.path.basename(root)!r}")

    def test_the_guard_refuses_a_commit_from_a_real_working_copy(self):
        wc = os.path.join(self.tmp, "wc")
        subprocess.run(["svn", "checkout", "--non-interactive", "--depth", "empty",
                        f"{SVN_ROOT}/{PLUGINS[0]}/trunk", wc], env=self.env, check=True, capture_output=True)
        # Even if the guard failed, an unmodified checkout has nothing to commit.
        result = subprocess.run(["svn", "commit", "--non-interactive", "-m", "never", wc], env=self.env,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 99, result.stderr)
        self.assertIn("write-guard: refused", result.stderr)


@unittest.skipUnless(LIVE, "set WPORG_LIVE=1 to read from wordpress.org")
class LiveMirrorReleaseTest(ActionTest):
    """QA on real releases: real artifacts in, every write to a local repository."""

    def real(self, *args):
        return subprocess.run(["svn", "--non-interactive", *args], env=self.env, check=True, capture_output=True,
                              timeout=1800).stdout

    def test_real_releases_through_all_three_actions(self):
        for slug in MIRROR:
            with self.subTest(slug=slug):
                self.mirror(slug)

    def mirror(self, slug):
        readme = self.real("cat", f"{SVN_ROOT}/{slug}/trunk/readme.txt")
        version = release.stable_tag(readme)
        names = self.real("list", f"{SVN_ROOT}/{slug}/tags/").decode().replace("/", "").split()
        older = [n for n in names if release.is_version(n) and release.compare(n, version) < 0]
        previous = max(older, key=lambda n: [int(p) for p in n.split(".")])
        started = time.time()

        # Seed a local repository with the real previous release (reads from wordpress.org).
        work = tempfile.mkdtemp(dir=self.tmp)
        exported = os.path.join(work, "previous")
        self.real("export", "-q", "--ignore-externals", f"{SVN_ROOT}/{slug}/tags/{previous}", exported)
        with open(os.path.join(exported, "readme.txt"), "rb") as handle:
            if release.stable_tag(handle.read()) != previous:
                self.skipTest(f"{slug} {previous}: the tag's readme does not name its own version")
        local = Repo(work, self.env, slug=slug)
        local.svn("import", "-q", "--no-ignore", "--no-auto-props", "-m", "seed", exported, local.url("seed"))
        local.mucc("rm", local.url("trunk"), "mv", local.url("seed"), local.url("trunk"))
        local.mucc("cp", "HEAD", local.url("trunk"), local.url(f"tags/{previous}"))

        common = {"WPORG_SLUG": slug, "WPORG_SVN_TEST_ROOT": local.root}
        tagged = self.run_action("tag", WPORG_ZIP_URL=zip_url(slug, version), **common)
        self.assert_success(tagged)
        self.assertEqual(tagged.outputs["version"], version)
        self.assertEqual(tagged.outputs["previous-stable"], previous)

        # The local tag must match the real one byte for byte (another read).
        real_tag = os.path.join(work, "real-tag")
        self.real("export", "-q", "--ignore-externals", f"{SVN_ROOT}/{slug}/tags/{version}", real_tag)
        local_tag = local.tree(f"tags/{version}")
        expected = read_tree(real_tag)
        differ = sorted(set(local_tag) ^ set(expected)) + sorted(
            k for k in set(local_tag) & set(expected) if local_tag[k] != expected[k])
        self.assertEqual(differ, [], f"local tags/{version} differs from the real one")

        self.assert_success(self.run_action("set-stable", WPORG_VERSION=version, **common))
        self.assert_success(self.run_action("update-trunk", WPORG_VERSION=version, **common))
        self.assertEqual(local.tree("trunk"), local_tag)
        self.assertEqual(release.stable_tag(local.cat("trunk/readme.txt")), version)
        print(f"\n  {slug}: {previous} -> {version}, {len(local_tag)} paths, "
              f"{len(local.changed(int(tagged.outputs['revision'])))} changed by the tag commit, "
              f"{time.time() - started:.0f}s")


if __name__ == "__main__":
    unittest.main()
