"""Races, failed commits, cancellation, ambiguous writes and secret handling.

Most failures come from real repository hooks. A few come from PATH wrappers:
those simulate what a file:// repository cannot produce (a lost network
response, an authentication or TLS failure), and each says so.
"""

import os
import signal
import time
import unittest

from support import PASSWORD, SIGNATURE, ActionTest, expected_tree, make_zip, plugin
from test_tag import NEXT, STABLE


class Base(ActionTest):
    def setUp(self):
        super().setUp()
        self.repo.seed("1.0", STABLE)
        self.https.routes["/release.zip"] = make_zip(NEXT)
        self.zip_url = f"{self.https.url}/release.zip?sig={SIGNATURE}"

    def tag(self, **env):
        env.setdefault("WPORG_ZIP_URL", self.zip_url)
        return self.run_action("tag", **env)

    def point_trunk_at(self, stable):
        """What set-stable does: trunk's readme names stable."""
        self.repo.mucc("put", self.staged(f"readme-{stable}.txt", plugin(stable)["readme.txt"]),
                       self.repo.url("trunk/readme.txt"))

    def staged(self, name, text):
        path = os.path.join(self.repo.staging, name)
        with open(path, "w") as handle:
            handle.write(text)
        return path

    def on_commit(self, number, command):
        """Run command from a start-commit hook, on the number-th commit only."""
        count = os.path.join(self.repo.staging, "commit-count")
        self.repo.hook("start-commit", f"""
n=$(cat '{count}' 2>/dev/null || echo 0); n=$((n + 1)); echo $n > '{count}'
if [ "$n" = {number} ]; then {command}; fi
""")


class TagCommitTest(Base):
    """The tag's only write: tags/<version> lands complete, or not at all."""

    def cancel_during(self, hook, marker):
        process = self.start("tag", WPORG_ZIP_URL=self.zip_url)
        deadline = time.time() + 120
        while not os.path.exists(marker) and time.time() < deadline:
            time.sleep(0.2)
        self.assertTrue(os.path.exists(marker), f"the {hook} hook never ran")
        os.killpg(process.pid, signal.SIGTERM)  # what a runner does when the job is cancelled
        result = self.finish(process, timeout=60)  # also checks temp cleanup and secrets
        self.assertEqual(result.code, 143, result.log)
        self.assertEqual(result.outputs, {})
        return result

    def test_a_rejected_commit_writes_nothing_and_a_rerun_succeeds(self):
        head = self.repo.head()
        self.repo.hook("pre-commit", "echo 'rejected by policy' >&2; exit 1\n")
        result = self.tag()
        self.assert_failure(result, r"the commit failed \(.*\) and tags/1\.1 does not exist at r\d+, "
                                    r"so nothing was written")
        self.assertRegex(result.log, r"Known revisions: snapshot r\d+, recheck r\d+\.")
        self.assertEqual(self.repo.head(), head)
        self.repo.hook("pre-commit", "exit 0\n")
        self.assert_success(self.tag())
        self.assertEqual(self.repo.tree("tags/1.1"), expected_tree(NEXT))

    def test_cancellation_during_the_commit_leaves_no_tag(self):
        marker = os.path.join(self.repo.staging, "committing")
        self.repo.hook("pre-commit", f"touch '{marker}'; sleep 30\n")
        result = self.cancel_during("pre-commit", marker)
        self.assertRegex(result.log, r"Failed while committing tags/1\.1")
        self.assertRegex(result.log, r"The commit's outcome is unknown: if tags/1\.1 exists")
        self.assertFalse(self.repo.exists("tags/1.1"))

    def test_cancellation_while_the_commit_lands_still_warns(self):
        marker = os.path.join(self.repo.staging, "committed")
        self.repo.hook("post-commit", f"touch '{marker}'; sleep 30\n")  # the commit is durable now
        result = self.cancel_during("post-commit", marker)
        self.assertTrue(self.repo.exists("tags/1.1"))
        self.assertRegex(result.log, r"if tags/1\.1 exists, do not approve or release it")

    def test_a_failed_verification_reports_what_the_tag_now_holds(self):
        # Simulated: a lost connection while exporting the committed tag.
        self.wrap("svn", 'case " $* " in *" export "*) echo "svn: E175002: Connection reset" >&2; exit 1;; esac\n'
                         'exec "$NEXT" "$@"')
        result = self.tag()
        self.assert_failure(result, r"Failed while verifying tags/1\.1")
        self.assertRegex(result.log, r"tags/1\.1 was created at r\d+ but not verified.*Do not approve or release it")


class RaceBeforeTheCommitTest(Base):
    def race_during_download(self, *actions):
        payload = self.https.routes["/release.zip"]

        def handler(request):
            self.repo.mucc(*actions, message="racer")
            request.send_response(200)
            request.send_header("Content-Length", str(len(payload)))
            request.end_headers()
            request.wfile.write(payload)

        self.https.routes["/release.zip"] = handler

    def assert_nothing_written(self, result, pattern, head):
        self.assert_failure(result, pattern)
        self.assertEqual(self.repo.head(), head + 1, "only the competing commit may land")
        self.assertFalse(self.repo.exists("tags/1.1"))

    def test_stable_pointer_moved_during_the_download(self):
        readme = self.staged("readme.txt", plugin("1.0", stable="0.9")["readme.txt"])
        self.repo.mucc("cp", "HEAD", self.repo.url("tags/1.0"), self.repo.url("tags/0.9"))
        head = self.repo.head()
        self.race_during_download("put", readme, self.repo.url("trunk/readme.txt"))
        self.assert_nothing_written(self.tag(), r"Stable Tag changed after r\d+", head)

    def test_stable_tag_edited_during_the_download(self):
        head = self.repo.head()
        self.race_during_download("put", self.staged("x.txt", "edited"), self.repo.url("tags/1.0/keep.txt"))
        self.assert_nothing_written(self.tag(), r"tags/1\.0 changed after r\d+", head)

    def test_destination_created_during_the_download(self):
        head = self.repo.head()
        self.race_during_download("mkdir", self.repo.url("tags/1.1"))
        result = self.tag()
        self.assert_failure(result, r"tags/1\.1 already exists at r\d+")
        self.assertEqual(self.repo.head(), head + 1)

    def test_destination_created_at_write_time_is_never_overwritten(self):
        self.on_commit(1, f"svnmucc --non-interactive -m racer mkdir '{self.repo.url('tags/1.1')}'")
        result = self.tag()
        self.assert_failure(result, r"the commit reported an error .* and tags/1\.1 now exists")
        self.assertRegex(result.log, "cannot confirm that it created it. Do not approve or release it")
        self.assertEqual(self.repo.tree("tags/1.1"), {}, "the other writer's tag stays as it was")

    def test_an_unrelated_new_tag_does_not_block_the_commit(self):
        self.on_commit(1, f"svnmucc --non-interactive -m racer mkdir '{self.repo.url('tags/0.5')}'")
        result = self.tag()
        self.assert_success(result)
        self.assertEqual(self.repo.tree("tags/1.1"), expected_tree(NEXT))


class AmbiguousWriteTest(Base):
    """A lost response after a successful write. file:// always answers, so a
    wrapper runs the real (guarded) write and then reports a timeout."""

    def lose_the_response(self):
        self.wrap("svnmucc", '"$NEXT" "$@" >/dev/null 2>&1\necho "svnmucc: E175012: Connection timed out" >&2\nexit 1')

    def test_tag_commit_with_a_lost_response_is_not_trusted(self):
        self.wrap("svn", 'case " $* " in *" commit "*) "$NEXT" "$@" >/dev/null 2>&1\n'
                         'echo "svn: E175012: Connection timed out" >&2; exit 1;; esac\nexec "$NEXT" "$@"')
        result = self.tag()
        self.assert_failure(result, r"the commit reported an error \(could not connect \(E175012\)\) and tags/1\.1 now exists")
        self.assertRegex(result.log, "cannot confirm that it created it")
        self.assertFalse(any("export" in call for call in self.svn_calls()), "never continue past an unconfirmed write")
        self.assertTrue(self.repo.exists("tags/1.1"))

    def test_set_stable_with_a_lost_response_says_a_rerun_is_safe(self):
        self.repo.put_tree("tags/1.1", plugin("1.1"))
        self.lose_the_response()
        result = self.run_action("set-stable", WPORG_VERSION="1.1")
        self.assert_failure(result, r"now matches tags/1\.1/readme\.txt\. Rerunning is safe")
        self.env["PATH"] = self.env["PATH"].split(os.pathsep, 1)[1]
        rerun = self.run_action("set-stable", WPORG_VERSION="1.1")
        self.assert_success(rerun)
        self.assertRegex(rerun.summary, "no-op")

    def test_update_trunk_with_a_lost_response_says_a_rerun_is_safe(self):
        self.repo.put_tree("tags/1.1", plugin("1.1"))
        self.point_trunk_at("1.1")
        self.lose_the_response()
        result = self.run_action("update-trunk", WPORG_VERSION="1.1")
        self.assert_failure(result, r"trunk now matches tags/1\.1\. Rerunning is safe")


class ErrorClassificationTest(Base):
    """Failed reads stop the action; they are never taken to mean "absent"."""

    def test_authentication_failure_on_the_commit(self):
        # Simulated: file:// never asks for credentials.
        self.wrap("svn", 'case " $* " in *" commit "*) echo "svn: E170001: Authorization failed" >&2; exit 1;; esac\n'
                         'exec "$NEXT" "$@"')
        head = self.repo.head()
        result = self.tag()
        self.assert_failure(result, r"the commit failed \(authentication failed \(E170001\)\) and tags/1\.1 does not exist")
        self.assertEqual(self.repo.head(), head)

    def test_tls_failure_on_a_read_is_not_absence(self):
        # Simulated: file:// has no TLS.
        self.wrap("svn", 'case " $* " in *" list "*) echo "svn: E170013: Unable to connect" >&2; '
                         'echo "svn: E230001: Server SSL certificate verification failed" >&2; exit 1;; esac\n'
                         'exec "$NEXT" "$@"')
        self.repo.put_tree("tags/1.1", plugin("1.1"))
        for action, env in (("set-stable", {"WPORG_VERSION": "1.1"}), ("tag", {"WPORG_ZIP_URL": self.zip_url})):
            with self.subTest(action=action):
                result = self.run_action(action, **env)
                self.assert_failure(result, r"SVN read failed while .*TLS certificate verification failed \(E170013 E230001\)")
                self.assertNotRegex(result.log, "does not exist")

    def test_connection_failure_on_a_read_is_not_absence(self):
        # Simulated: file:// cannot drop a connection.
        self.wrap("svn", 'case " $* " in *" list "*) echo "svn: E170013: Unable to connect" >&2; '
                         'echo "svn: E175002: Connection reset" >&2; exit 1;; esac\nexec "$NEXT" "$@"')
        result = self.run_action("update-trunk", WPORG_VERSION="1.1")
        self.assert_failure(result, r"could not connect \(E170013 E175002\)")
        self.assertNotRegex(result.log, "does not exist")

    def test_connection_failure_while_copying_the_stable_tag_stops_the_tag(self):
        # Simulated: file:// cannot drop a connection.
        self.wrap("svn", 'case " $* " in *" copy "*) echo "svn: E170013: Unable to connect" >&2; '
                         'echo "svn: E175002: Connection reset" >&2; exit 1;; esac\nexec "$NEXT" "$@"')
        head = self.repo.head()
        result = self.tag()
        self.assert_failure(result, r"SVN read failed while copying tags/1\.0 into a working copy: "
                                    r"could not connect \(E170013 E175002\)")
        self.assertEqual(self.repo.head(), head)

    def test_permission_failure_is_not_absence(self):
        db = os.path.join(self.repo.dir, "db")
        os.chmod(db, 0)
        self.addCleanup(os.chmod, db, 0o755)
        result = self.run_action("set-stable", WPORG_VERSION="1.1")
        self.assert_failure(result, r"SVN read failed while reading .*permission denied")
        self.assertNotRegex(result.log, "does not exist")


class HelperFailureTest(Base):
    """A helper that crashes must stop the action, never read as "nothing found"."""

    def test_a_crash_while_looking_for_the_destination_stops_the_tag(self):
        self.wrap("python3", 'case " $* " in *" equivalents "*) exit 1;; esac\nexec "$NEXT" "$@"')
        head = self.repo.head()
        self.assert_failure(self.tag(), r"Failed while checking tags/1\.1")
        self.assertEqual(self.repo.head(), head)

    def test_unreadable_diff_output_stops_update_trunk(self):
        self.repo.put_tree("tags/1.1", plugin("1.1"))
        self.point_trunk_at("1.1")
        self.wrap("svn", 'case " $* " in *" diff "*) echo "<not xml"; exit 0;; esac\nexec "$NEXT" "$@"')
        head = self.repo.head()
        self.assert_failure(self.run_action("update-trunk", WPORG_VERSION="1.1"), r"could not read svn's diff output")
        self.assertEqual(self.repo.head(), head)


class SecretsTest(Base):
    def test_password_reaches_svn_only_on_stdin(self):
        dump = os.path.join(self.tmp, "child-env")
        for tool in ("svn", "curl"):
            self.wrap(tool, f'env >> \'{dump}\'\nexec "$NEXT" "$@"')
        result = self.tag()
        self.assert_success(result)
        argv = repr(self.svn_calls())
        self.assertIn("--password-from-stdin", argv)
        self.assertNotIn(PASSWORD, argv)
        with open(dump) as handle:
            inherited = PASSWORD in handle.read()  # never dump the environment into test output
        self.assertFalse(inherited, "child processes must not inherit the password")

    def test_signed_url_is_never_echoed_even_on_failure(self):
        self.https.routes["/release.zip"] = make_zip({"readme.txt": "broken"})
        result = self.tag()  # finish() asserts the signature appears nowhere
        self.assertNotEqual(result.code, 0)


class RunnerTest(Base):
    def test_unsupported_runner(self):
        self.assert_failure(self.tag(RUNNER_OS="Windows"), "unsupported runner")

    def test_missing_tool(self):
        path = self.env["PATH"]
        for missing in ("svn", "curl"):
            with self.subTest(missing=missing):
                # A PATH holding every tool except the missing one.
                farm = os.path.join(self.tmp, "farm-" + missing)
                os.makedirs(farm)
                for folder in path.split(os.pathsep):
                    for name in (os.listdir(folder) if os.path.isdir(folder) else []):
                        link, target = os.path.join(farm, name), os.path.join(folder, name)
                        if name != missing and not os.path.lexists(link) and os.access(target, os.X_OK):
                            os.symlink(target, link)
                self.env["PATH"] = farm
                self.assert_failure(self.tag(), "missing required tool: " + missing)


if __name__ == "__main__":
    unittest.main()
