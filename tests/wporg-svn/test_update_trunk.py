"""update-trunk: replace trunk with tags/<version> in one atomic, revision-pinned commit."""

import unittest

from support import ActionTest, SLUG, plugin, write


class UpdateTrunkTest(ActionTest):
    def setUp(self):
        super().setUp()
        self.repo.seed("1.0", plugin("1.0", extra={"dev-only.txt": "trunk work", "src/old.php": "<?php //"}))
        self.repo.put_tree("tags/1.1", plugin("1.1", extra={"src/new.php": "<?php // new", "empty/": None,
                                                          "img/logo.png": b"\x89PNG"}))
        self.repo.mucc("propset", "svn:mime-type", "image/png", self.repo.url("tags/1.1/img/logo.png"),
                       "propset", "custom:flag", "on", self.repo.url("tags/1.1"))
        self.point_trunk_at("1.1")  # what set-stable does
        self.snapshot = self.repo.head()

    def point_trunk_at(self, stable):
        readme = write(self.repo.staging, f"readme-{stable}.txt", plugin(stable)["readme.txt"])
        self.repo.mucc("put", readme, self.repo.url("trunk/readme.txt"))

    def update_trunk(self, version="1.1", **env):
        return self.run_action("update-trunk", WPORG_VERSION=version, **env)

    def test_replaces_trunk_with_the_tag_in_one_revision(self):
        tag_tree, tag_props = self.repo.tree("tags/1.1"), self.repo.props("tags/1.1")
        untouched = {path: self.repo.tree(path) for path in ("tags/1.0", "assets")}
        result = self.update_trunk()
        self.assert_success(result)

        revision = int(result.outputs["revision"])
        self.assertEqual(result.outputs["version"], "1.1")
        self.assertEqual(revision, self.snapshot + 1)
        self.assertEqual(self.repo.changed(revision), [("R", f"/{SLUG}/trunk")])
        self.assertEqual(self.repo.tree("trunk"), tag_tree)
        self.assertEqual(self.repo.props("trunk"), tag_props)
        for path, tree in untouched.items():
            self.assertEqual(self.repo.tree(path), tree)
        log = self.repo.svn("log", "-v", "--xml", "-r", str(revision), self.repo.root).decode()
        self.assertIn(f'copyfrom-path="/{SLUG}/tags/1.1"', log)
        self.assertIn(f'copyfrom-rev="{self.snapshot}"', log)

    def test_never_checks_out_or_transfers_the_tree(self):
        self.assert_success(self.update_trunk())
        commands = {call[call.index(arg)] for call in self.svn_calls() for arg in call
                    if arg in ("checkout", "co", "export", "update", "up", "commit", "ci", "import")}
        self.assertEqual(commands, set())

    def test_identical_trunk_is_a_verified_no_op(self):
        self.assert_success(self.update_trunk())
        head = self.repo.head()
        result = self.update_trunk()
        self.assert_success(result)
        self.assertEqual(self.repo.head(), head)
        self.assertEqual(result.outputs, {"version": "1.1", "revision": str(head)})
        self.assertRegex(result.summary, "(?i)no-op")

    def test_property_or_empty_directory_differences_are_not_a_no_op(self):
        for change in (("propset", "custom:flag", "off", self.repo.url("trunk")),
                       ("propdel", "svn:mime-type", self.repo.url("trunk/img/logo.png")),
                       ("mkdir", self.repo.url("trunk/extra-empty"))):
            with self.subTest(change=change[0]):
                self.assert_success(self.update_trunk())
                self.repo.mucc(*change)
                head = self.repo.head()
                result = self.update_trunk()
                self.assert_success(result)
                self.assertEqual(int(result.outputs["revision"]), head + 1, "must commit, not no-op")
                self.assertEqual(self.repo.props("trunk"), self.repo.props("tags/1.1"))

    def test_refuses_until_set_stable_points_at_the_version(self):
        # update-trunk also replaces trunk/readme.txt: run first, it would release by itself.
        self.point_trunk_at("1.0")
        head, trunk = self.repo.head(), self.repo.tree("trunk")
        result = self.update_trunk()
        self.assert_failure(result, r"the trunk/readme\.txt Stable Tag is not 1\.1 at r\d+; run set-stable for 1\.1 first")
        self.assertEqual(self.repo.head(), head)
        self.assertEqual(self.repo.tree("trunk"), trunk)

    def test_trunk_follows_a_rollback_by_set_stable(self):
        self.assert_success(self.update_trunk())
        self.assert_success(self.run_action("set-stable", WPORG_VERSION="1.0"))
        self.assert_success(self.update_trunk("1.0"))
        self.assertEqual(self.repo.tree("trunk"), self.repo.tree("tags/1.0"))

    def test_expected_revision_refuses_a_tag_changed_after_approval(self):
        approved = self.repo.last_changed("tags/1.1")
        self.repo.mucc("put", write(self.repo.staging, "late.php", "<?php // after QA"),
                       self.repo.url("tags/1.1/late.php"))
        head, trunk = self.repo.head(), self.repo.tree("trunk")
        result = self.update_trunk(WPORG_EXPECTED_REVISION=str(approved))
        self.assert_failure(result, rf"tags/1\.1 last changed at r{head}, not at the expected r{approved}")
        self.assertEqual((self.repo.head(), self.repo.tree("trunk")), (head, trunk))
        self.assert_success(self.update_trunk(WPORG_EXPECTED_REVISION=str(head)))

    def test_missing_tag_fails_without_writing(self):
        self.assert_failure(self.update_trunk("1.5"), r"tags/1\.5 does not exist")
        self.assertEqual(self.repo.head(), self.snapshot)

    def test_missing_trunk_fails_without_writing(self):
        self.repo.mucc("rm", self.repo.url("trunk"))
        head = self.repo.head()
        self.assert_failure(self.update_trunk(), r"trunk does not exist")
        self.assertEqual(self.repo.head(), head)

    def test_invalid_version_fails(self):
        self.assert_failure(self.update_trunk("1.1-rc1"), r"version must be")
        self.assertEqual(self.repo.head(), self.snapshot)

    def test_concurrent_edit_inside_trunk_aborts_the_whole_replacement(self):
        racer = self.repo.staging + "/racer.php"
        with open(racer, "w") as handle:
            handle.write("<?php // someone else's trunk work\n")
        marker = self.repo.staging + "/race-once"
        open(marker, "w").close()
        self.repo.hook("start-commit", f"""
if [ -e '{marker}' ]; then
  rm '{marker}'
  svnmucc --non-interactive -m racer put '{racer}' '{self.repo.url("trunk/src/old.php")}' >/dev/null
fi
""")
        result = self.update_trunk()
        self.assert_failure(result, r"out of date")
        self.assertEqual(self.repo.cat("trunk/src/old.php").decode(), open(racer).read())
        self.assertIn("dev-only.txt", self.repo.tree("trunk"), "trunk must be left intact")
        self.assertEqual(self.repo.head(), self.snapshot + 1, "only the competing commit may land")

    def test_copies_the_snapshot_even_if_the_tag_changes_afterwards(self):
        # The tag changes after our reads and before our write starts (a real
        # commit, timed by the wrapper). The copy must still take the snapshot.
        tag_at_snapshot = self.repo.tree("tags/1.1")
        racer = self.repo.staging + "/edited.php"
        with open(racer, "w") as handle:
            handle.write("<?php // edited after the snapshot\n")
        marker = self.repo.staging + "/raced"
        self.wrap("svnmucc", f"""
if [ ! -e '{marker}' ]; then
  touch '{marker}'
  "$NEXT" --non-interactive -m racer put '{racer}' '{self.repo.url("tags/1.1/src/new.php")}' >/dev/null
fi
exec "$NEXT" "$@"
""")
        result = self.update_trunk()
        self.assert_success(result)
        self.assertEqual(self.repo.tree("trunk"), tag_at_snapshot)
        self.assertNotEqual(self.repo.tree("trunk"), self.repo.tree("tags/1.1"))

    def test_rejected_transaction_leaves_trunk_intact(self):
        trunk = self.repo.tree("trunk")
        self.repo.hook("pre-commit", "echo 'rejected by policy' >&2\nexit 1\n")
        result = self.update_trunk()
        self.assert_failure(result, r"trunk was not changed by this run")
        self.assertEqual(self.repo.head(), self.snapshot)
        self.assertEqual(self.repo.tree("trunk"), trunk)


    def test_edit_between_snapshot_and_write_aborts_the_replacement(self):
        # As in set-stable: a real competing commit, timed by the wrapper to land
        # after our reads and before our write starts.
        racer = self.repo.staging + "/racer.php"
        with open(racer, "w") as handle:
            handle.write("<?php // after the snapshot\n")
        marker = self.repo.staging + "/raced"
        self.wrap("svnmucc", f"""
if [ ! -e '{marker}' ]; then
  touch '{marker}'
  "$NEXT" --non-interactive -m racer put '{racer}' '{self.repo.url("trunk/src/old.php")}' >/dev/null
fi
exec "$NEXT" "$@"
""")
        result = self.update_trunk()
        self.assert_failure(result, r"out of date")
        self.assertEqual(self.repo.cat("trunk/src/old.php").decode(), open(racer).read())
        self.assertIn("dev-only.txt", self.repo.tree("trunk"))


if __name__ == "__main__":
    unittest.main()
