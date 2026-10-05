"""Races, failures between commits, cancellation, ambiguous writes and secret handling.

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


class BetweenTagCommitsTest(Base):
    def reject_populate(self):
        self.repo.hook("pre-commit", """
if svnlook log -t "$2" "$1" | grep -q populate; then echo 'rejected by policy' >&2; exit 1; fi
""")

    def test_failure_after_the_copy_reports_an_incomplete_tag(self):
        self.reject_populate()
        result = self.tag()
        self.assert_failure(result, r"tags/1\.1 is unchanged since r\d+")
        self.assertRegex(result.log, r"tags/1\.1 exists since r\d+ and is INCOMPLETE: it still holds the 1\.0 files")
        self.assertRegex(result.log, r"Known revisions: snapshot r\d+, recheck r\d+, copy r\d+")
        self.assertRegex(result.summary, "INCOMPLETE")
        self.assertEqual(self.repo.tree("tags/1.1"), self.repo.tree("tags/1.0"), "the copy is left as it is")

    def test_a_rerun_never_reuses_the_incomplete_tag(self):
        self.reject_populate()
        self.assert_failure(self.tag(), "INCOMPLETE")
        incomplete, head = self.repo.tree("tags/1.1"), self.repo.head()
        self.repo.hook("pre-commit", "exit 0\n")
        self.assert_failure(self.tag(), r"tags/1\.1 already exists")
        self.assertEqual((self.repo.tree("tags/1.1"), self.repo.head()), (incomplete, head))

    def test_cancellation_between_commits_reports_and_cleans_up(self):
        marker = os.path.join(self.repo.staging, "populating")
        self.repo.hook("pre-commit", f"""
if svnlook log -t "$2" "$1" | grep -q populate; then touch '{marker}'; sleep 30; fi
""")
        process = self.start("tag", WPORG_ZIP_URL=self.zip_url)
        deadline = time.time() + 120
        while not os.path.exists(marker) and time.time() < deadline:
            time.sleep(0.2)
        self.assertTrue(os.path.exists(marker), "the populate commit never started")
        os.killpg(process.pid, signal.SIGTERM)  # what a runner does when the job is cancelled
        result = self.finish(process, timeout=60)  # also checks temp cleanup and secrets
        self.assertEqual(result.code, 143, result.log)
        self.assertRegex(result.log, r"Failed while committing the artifact to tags/1\.1")
        self.assertRegex(result.log, "INCOMPLETE")
        self.assertEqual(result.outputs, {})

    def test_cancellation_while_the_copy_lands_still_warns(self):
        marker = os.path.join(self.repo.staging, "copied")
        self.repo.hook("post-commit", f"touch '{marker}'; sleep 30\n")  # the copy is durable now
        process = self.start("tag", WPORG_ZIP_URL=self.zip_url)
        deadline = time.time() + 120
        while not os.path.exists(marker) and time.time() < deadline:
            time.sleep(0.2)
        self.assertTrue(os.path.exists(marker), "the copy never committed")
        os.killpg(process.pid, signal.SIGTERM)
        result = self.finish(process, timeout=60)
        self.assertEqual(result.code, 143, result.log)
        self.assertTrue(self.repo.exists("tags/1.1"))
        self.assertRegex(result.log, r"if tags/1\.1 exists, treat it as INCOMPLETE")

    def test_a_failed_verification_reports_what_the_tag_now_holds(self):
        # Simulated: a lost connection while exporting the committed tag.
        self.wrap("svn", 'case " $* " in *" export "*) echo "svn: E175002: Connection reset" >&2; exit 1;; esac\n'
                         'exec "$NEXT" "$@"')
        result = self.tag()
        self.assert_failure(result, r"Failed while verifying tags/1\.1")
        self.assertRegex(result.log, r"tags/1\.1 was populated at r\d+ but not verified")
        self.assertNotRegex(result.log, "still holds the 1.0 files")

    def test_competing_edit_to_a_file_we_change_fails_the_commit(self):
        racer = self.staged("racer.php", "<?php // someone else\n")
        self.on_commit(2, f"svnmucc --non-interactive -m racer put '{racer}' '{self.repo.url('tags/1.1/src/a.php')}'")
        result = self.tag()
        self.assert_failure(result, r"tags/1\.1 changed at r\d+; this run cannot confirm what it holds")
        self.assertRegex(result.log, "INCOMPLETE")
        self.assertEqual(self.repo.cat("tags/1.1/src/a.php").decode(), open(racer).read())

    def test_competing_new_file_is_caught_by_verification(self):
        extra = self.staged("extra.txt", "not in the artifact\n")
        self.on_commit(2, f"svnmucc --non-interactive -m racer put '{extra}' '{self.repo.url('tags/1.1/extra.txt')}'")
        result = self.tag()
        self.assert_failure(result, r"tags/1\.1 at r\d+ does not match the artifact")
        self.assertRegex(result.log, "differs: extra.txt")
        self.assertRegex(result.log, r"tags/1\.1 was populated at r\d+ but not verified.*Do not approve or release it")


class RaceBeforeTheCopyTest(Base):
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
        self.assert_failure(result, r"the copy reported an error .* and tags/1\.1 now exists")
        self.assertRegex(result.log, "cannot confirm that it created it. Do not approve or release it")
        self.assertEqual(self.repo.tree("tags/1.1"), {}, "the other writer's tag stays as it was")

    def test_an_unrelated_new_tag_does_not_block_the_copy(self):
        self.on_commit(1, f"svnmucc --non-interactive -m racer mkdir '{self.repo.url('tags/0.5')}'")
        result = self.tag()
        self.assert_success(result)
        self.assertEqual(self.repo.tree("tags/1.1"), expected_tree(NEXT))


class AmbiguousWriteTest(Base):
    """A lost response after a successful write. file:// always answers, so a
    wrapper runs the real (guarded) write and then reports a timeout."""

    def lose_the_response(self):
        self.wrap("svnmucc", '"$NEXT" "$@" >/dev/null 2>&1\necho "svnmucc: E175012: Connection timed out" >&2\nexit 1')

    def test_tag_copy_with_a_lost_response_is_not_trusted(self):
        self.lose_the_response()
        result = self.tag()
        self.assert_failure(result, r"the copy reported an error \(could not connect \(E175012\)\) and tags/1\.1 now exists")
        self.assertRegex(result.log, "cannot confirm that it created it")
        self.assertFalse(any("checkout" in call for call in self.svn_calls()), "never continue past an unconfirmed write")
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
        self.lose_the_response()
        result = self.run_action("update-trunk", WPORG_VERSION="1.1")
        self.assert_failure(result, r"trunk now matches tags/1\.1\. Rerunning is safe")


class ErrorClassificationTest(Base):
    """Failed reads stop the action; they are never taken to mean "absent"."""

    def test_authentication_failure_on_the_copy(self):
        # Simulated: file:// never asks for credentials.
        self.wrap("svnmucc", 'echo "svnmucc: E170001: Authorization failed" >&2\nexit 1')
        result = self.tag()
        self.assert_failure(result, r"the copy failed \(authentication failed \(E170001\)\) and tags/1\.1 does not exist")

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

    def test_connection_failure_while_dumping_the_stable_tag_is_not_absence(self):
        # Simulated: file:// cannot drop a connection.
        self.wrap("svnrdump", 'echo "svnrdump: E170013: Unable to connect" >&2; '
                              'echo "svnrdump: E175002: Connection reset" >&2; exit 1')
        head = self.repo.head()
        result = self.tag()
        self.assert_failure(result, r"SVN read failed while checking tags/1\.1 and tags/1\.0: "
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

    def assert_unreadable_dump_stops_the_tag(self, body):
        self.wrap("svnrdump", body)
        head = self.repo.head()
        self.assert_failure(self.tag(), r"could not read svnrdump's output for tags/1\.0")
        self.assertEqual(self.repo.head(), head)

    def test_a_truncated_dump_of_the_stable_tag_stops_the_tag(self):
        self.assert_unreadable_dump_stops_the_tag('out=$(mktemp)\n"$NEXT" "$@" >"$out" || exit\n'
                                                  'head -c $(($(wc -c <"$out") / 2)) "$out"; rm -f "$out"')

    def test_a_garbled_dump_of_the_stable_tag_stops_the_tag(self):
        self.assert_unreadable_dump_stops_the_tag('"$NEXT" "$@" | LC_ALL=C sed "s/^Node-action: add$/Node-action: change/"')

    def test_unreadable_diff_output_stops_update_trunk(self):
        self.repo.put_tree("tags/1.1", plugin("1.1"))
        self.wrap("svn", 'case " $* " in *" diff "*) echo "<not xml"; exit 0;; esac\nexec "$NEXT" "$@"')
        head = self.repo.head()
        self.assert_failure(self.run_action("update-trunk", WPORG_VERSION="1.1"), r"could not read svn's diff output")
        self.assertEqual(self.repo.head(), head)


class SecretsTest(Base):
    def test_password_reaches_svn_only_on_stdin(self):
        dump = os.path.join(self.tmp, "child-env")
        for tool in ("svn", "svnmucc", "curl"):
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
        for missing in ("svnmucc", "svnrdump"):
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
