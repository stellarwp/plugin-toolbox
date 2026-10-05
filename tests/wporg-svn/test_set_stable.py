"""set-stable: copy tags/<version>/readme.txt over trunk/readme.txt, server-side only."""

import unittest

from support import ActionTest, SLUG, plugin


class SetStableTest(ActionTest):
    def setUp(self):
        super().setUp()
        self.repo.seed("1.0")
        self.repo.put_tree("tags/1.1", plugin("1.1"))

    def set_stable(self, version="1.1", **env):
        return self.run_action("set-stable", WPORG_VERSION=version, **env)

    def test_copies_the_tag_readme_into_trunk_and_nothing_else(self):
        before = self.repo.head()
        trunk_before = self.repo.tree("trunk")
        result = self.set_stable()
        self.assert_success(result)

        revision = int(result.outputs["revision"])
        self.assertEqual(result.outputs["version"], "1.1")
        self.assertEqual(revision, before + 1)
        self.assertEqual(self.repo.changed(revision), [("M", f"/{SLUG}/trunk/readme.txt")])
        self.assertEqual(self.repo.cat("trunk/readme.txt"), self.repo.cat("tags/1.1/readme.txt"))
        trunk_after = self.repo.tree("trunk")
        del trunk_before["readme.txt"], trunk_after["readme.txt"]
        self.assertEqual(trunk_after, trunk_before)

    def test_preserves_the_exact_readme_bytes(self):
        readme = b"=== X ===\r\nStable tag: 1.2\r\n\r\nShort.\r\n\xe2\x9c\x93 bytes \t \r\n"
        self.repo.put_tree("tags/1.2", {**plugin("1.2"), "readme.txt": readme})
        self.assert_success(self.set_stable("1.2"))
        self.assertEqual(self.repo.cat("trunk/readme.txt"), readme)

    def test_identical_readme_is_a_verified_no_op(self):
        self.assert_success(self.set_stable())
        head = self.repo.head()
        result = self.set_stable()
        self.assert_success(result)
        self.assertEqual(self.repo.head(), head, "a no-op must not commit")
        self.assertEqual(result.outputs, {"version": "1.1", "revision": str(head)})
        self.assertRegex(result.summary, "(?i)no-op")

    def test_can_select_an_older_tag(self):
        # Documented: set-stable has no upgrade-only policy, so this rolls back.
        self.assert_success(self.set_stable("1.1"))
        self.assert_success(self.set_stable("1.0"))
        self.assertEqual(self.repo.cat("trunk/readme.txt"), self.repo.cat("tags/1.0/readme.txt"))

    def test_missing_tag_fails_without_writing(self):
        head = self.repo.head()
        self.assert_failure(self.set_stable("1.5"), r"tags/1\.5 does not exist")
        self.assertEqual(self.repo.head(), head)

    def test_tag_without_readme_fails(self):
        self.repo.mucc("rm", self.repo.url("tags/1.1/readme.txt"))
        head = self.repo.head()
        self.assert_failure(self.set_stable(), r"tags/1\.1/readme\.txt")
        self.assertEqual(self.repo.head(), head)

    def test_trunk_readme_must_be_a_file(self):
        self.repo.mucc("rm", self.repo.url("trunk/readme.txt"), "mkdir", self.repo.url("trunk/readme.txt"))
        head = self.repo.head()
        self.assert_failure(self.set_stable(), r"trunk/readme\.txt")
        self.assertEqual(self.repo.head(), head)

    def test_mismatched_stable_tag_fails(self):
        self.repo.put_tree("tags/1.2", plugin("1.2", stable="1.1"))
        self.repo.put_tree("tags/1.3", plugin("1.3", stable="1.3.0"))
        head = self.repo.head()
        self.assert_failure(self.set_stable("1.2"), r"Stable Tag .*is not 1\.2")
        self.assert_failure(self.set_stable("1.3"), r"Stable Tag .*is not 1\.3")
        self.assertEqual(self.repo.head(), head)

    def test_content_transforming_properties_fail(self):
        self.repo.mucc("propset", "svn:keywords", "Id", self.repo.url("tags/1.1/readme.txt"))
        head = self.repo.head()
        self.assert_failure(self.set_stable(), r"svn:keywords")
        self.assertEqual(self.repo.head(), head)

    def test_invalid_inputs_fail_before_any_svn_access(self):
        head = self.repo.head()
        for version in ("", "v1.1", "1.1-beta", "trunk", "1.1 ", "../1.1"):
            with self.subTest(version=version):
                self.assert_failure(self.set_stable(version), r"version must be")
        for slug in ("", "Fixture", "../fixture", "fixture plugin", "fixture--plugin", "-fixture", "a/b", "%2e"):
            with self.subTest(slug=slug):
                self.assert_failure(self.set_stable(WPORG_SLUG=slug), r"plugin-slug must be")
        self.assertEqual(self.repo.head(), head)

    def test_missing_credentials_fail(self):
        self.assert_failure(self.set_stable(WPORG_PASSWORD=""), r"wporg-username and wporg-password")
        self.assert_failure(self.set_stable(WPORG_USERNAME=None), r"wporg-username and wporg-password")

    def test_concurrent_trunk_readme_edit_is_never_overwritten(self):
        # A competing commit lands between our snapshot and our write.
        racer = self.repo.staging + "/racer-readme.txt"
        with open(racer, "w") as handle:
            handle.write("=== X ===\nStable tag: 1.0\n\nEdited by someone else.\n")
        marker = self.repo.staging + "/race-once"
        open(marker, "w").close()
        self.repo.hook("start-commit", f"""
if [ -e '{marker}' ]; then
  rm '{marker}'
  svnmucc --non-interactive -m racer put '{racer}' '{self.repo.url("trunk/readme.txt")}' >/dev/null
fi
""")
        result = self.set_stable()
        self.assert_failure(result, r"(?i)out of date|conflict")
        self.assertEqual(self.repo.cat("trunk/readme.txt").decode(), open(racer).read())
        self.assertRegex(result.log, r"trunk/readme\.txt was not changed by this run")


    def test_edit_between_snapshot_and_write_is_never_overwritten(self):
        # The -r <snapshot> baseline's own window: another commit lands after our
        # reads and before our write starts. The wrapper only times that real
        # commit; it fakes nothing about SVN.
        racer = self.repo.staging + "/racer-readme.txt"
        with open(racer, "w") as handle:
            handle.write("=== X ===\nStable tag: 1.0\n\nEdited after the snapshot.\n")
        marker = self.repo.staging + "/raced"
        self.wrap("svnmucc", f"""
if [ ! -e '{marker}' ]; then
  touch '{marker}'
  "$NEXT" --non-interactive -m racer put '{racer}' '{self.repo.url("trunk/readme.txt")}' >/dev/null
fi
exec "$NEXT" "$@"
""")
        result = self.set_stable()
        self.assert_failure(result, r"out of date")
        self.assertEqual(self.repo.cat("trunk/readme.txt").decode(), open(racer).read())


if __name__ == "__main__":
    unittest.main()
