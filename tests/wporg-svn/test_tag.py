"""tag: create tags/<version> in one commit, as a copy of the stable tag that matches the ZIP exactly."""

import os
import shutil
import subprocess
import tempfile
import unittest

from support import ActionTest, SIGNATURE, SLUG, add_unicode_path_entry, as_bytes, expected_tree, make_zip, plugin, write

STABLE = plugin("1.0", extra={
    "keep.txt": "unchanged",
    "same-size.txt": "AAAA",
    "src/a.php": "<?php // a 1.0",
    "src/old-dir/x.php": "<?php // removed in 1.1",
    ".hidden": "old dotfile",
    "old@x.txt": "removed in 1.1",
    "will-be-dir": "a file in 1.0",
    "will-be-file/child.txt": "a directory in 1.0",
    "languages/caf\u00e9.txt": "non-ASCII name, edited in 1.1",
    "languages/old-\u00fcml\u00e4ut.txt": "non-ASCII name, removed in 1.1",
})

NEXT = plugin("1.1", extra={
    "keep.txt": "unchanged",
    "same-size.txt": "BBBB",
    "src/a.php": "<?php // a 1.1",
    "src/new.php": "<?php // hidden by svn:ignore on src",
    "src/new dir/with space.php": "<?php // spaces",
    "a@b.txt": "at sign",
    "-dash.txt": "leading dash",
    ".htaccess": "new dotfile",
    "will-be-dir/child.txt": "now a directory",
    "will-be-file": "now a file",
    "empty-dir/": None,
    "vendor/lib.so": b"\x7fELF",
    "lang/new.mo": b"\xde\x12\x04\x95\x00\x00\x00\x00" * 64,  # binary: svn add sets svn:mime-type
    "build~": "matches the default global-ignores",
    "languages/caf\u00e9.txt": "non-ASCII name, edited",
    "languages/na\u00efve r\u00e9sum\u00e9.txt": "non-ASCII name, added",
    "\u65e5\u672c\u8a9e/\u30d5\u30a1\u30a4\u30eb.txt": "CJK names, added",
})


class TagTest(ActionTest):
    def setUp(self):
        super().setUp()
        self.repo.seed("1.0", STABLE)
        self.repo.mucc("propset", "svn:ignore", "*.php", self.repo.url("tags/1.0/src"))

    def serve(self, files=None, wrapper=None, path="/release.zip"):
        self.https.routes[path] = make_zip(NEXT if files is None else files, wrapper)
        return f"{self.https.url}{path}?sig={SIGNATURE}"

    def tag(self, zip_url=None, **env):
        if "WPORG_ZIP_URL" not in env:
            env["WPORG_ZIP_URL"] = zip_url or self.serve()
        return self.run_action("tag", **env)

    def frozen(self):
        return {path: self.repo.tree(path) for path in ("trunk", "tags/1.0", "assets")}

    def test_prepares_the_new_tag_from_the_artifact(self):
        before, snapshot = self.frozen(), self.repo.head()
        result = self.tag()
        self.assert_success(result)

        revision = int(result.outputs["revision"])
        self.assertEqual(result.outputs["version"], "1.1")
        self.assertEqual(result.outputs["previous-stable"], "1.0")
        self.assertEqual(revision, snapshot + 1, "the tag must appear in a single commit")
        self.assertEqual(self.repo.tree("tags/1.1"), expected_tree(NEXT))
        self.assertEqual(self.frozen(), before, "trunk, the stable tag and assets must not change")

        changed = self.repo.changed(revision)
        self.assertIn(("A", f"/{SLUG}/tags/1.1"), changed)
        self.assertTrue(all(path == f"/{SLUG}/tags/1.1" or path.startswith(f"/{SLUG}/tags/1.1/")
                            for _, path in changed))
        log = self.repo.svn("log", "-v", "--xml", "-r", str(revision), self.repo.root).decode()
        self.assertIn(f'copyfrom-path="/{SLUG}/tags/1.0"', log)
        self.assertIn(f'copyfrom-rev="{snapshot}"', log)

    def test_binary_files_are_added_byte_for_byte(self):
        self.assert_success(self.tag())
        self.assertEqual(self.repo.cat("tags/1.1/lang/new.mo"), NEXT["lang/new.mo"])
        self.assertEqual(self.repo.props("tags/1.1/lang/new.mo")[""], {"svn:mime-type": "application/octet-stream"})

    def test_inherited_auto_props_never_reach_new_files(self):
        self.repo.mucc("propset", "svn:auto-props", "*.php = svn:eol-style=native;svn:keywords=Id\n", self.repo.url())
        self.assert_success(self.tag())
        props = self.repo.props("tags/1.1")
        self.assertFalse([path for path, values in props.items() if "svn:eol-style" in values or "svn:keywords" in values])
        self.assertEqual(self.repo.tree("tags/1.1"), expected_tree(NEXT))

    def test_the_stable_tag_is_downloaded_once_and_nothing_else(self):
        snapshot = self.repo.head()
        self.assert_success(self.tag())
        calls = self.svn_calls()
        self.assertEqual([call[0] for call in calls if call[0] != "svn"], [], "no svnmucc or svnrdump")
        checkouts = [call for call in calls if "checkout" in call or "co" in call]
        self.assertEqual(len(checkouts), 1)
        self.assertIn("empty", checkouts[0])
        self.assertIn(f"{self.repo.url('tags')}@{snapshot}", checkouts[0])
        copies = [call for call in calls if "copy" in call or "cp" in call]
        self.assertEqual(len(copies), 1)
        self.assertIn(f"{self.repo.url('tags/1.0')}@{snapshot}", copies[0])
        self.assertIn("--ignore-externals", copies[0])
        # svn proplist -R on a URL asks for every path separately: minutes on a large tag.
        remote = [call for call in calls if "proplist" in call and any(a.startswith("file:") for a in call)]
        self.assertEqual(remote, [])

    def test_an_artifact_identical_to_the_stable_tag_writes_nothing(self):
        # A legacy repository whose tags/1.0 already holds the 1.1 release.
        self.repo.mucc("rm", self.repo.url("tags/1.0"))
        self.repo.put_tree("tags/1.0", NEXT)
        self.rejected(r"the artifact is identical to tags/1\.0; there is nothing to release")
        self.assertFalse(self.repo.exists("tags/1.1"))

    def test_adds_and_deletes_are_batched(self):
        # One svn add and one svn rm, however many paths: per-path calls take
        # minutes on a large release.
        files = plugin("1.1", extra={**{f"new/{i}.txt": "n" for i in range(20)},
                                     **{f"top{i}@x.txt": "t" for i in range(5)}, "naïve résumé.txt": "u"})
        self.assert_success(self.tag(self.serve(files)))
        calls = self.svn_calls()
        self.assertEqual(sum("add" in call for call in calls), 1)
        self.assertEqual(sum("rm" in call for call in calls), 1)
        self.assertEqual(self.repo.tree("tags/1.1"), expected_tree(files))

    def test_unchanged_files_keep_their_history(self):
        self.assert_success(self.tag())
        log = self.repo.svn("log", "-q", self.repo.url("tags/1.1/keep.txt")).decode()
        self.assertGreaterEqual(log.count("\nr"), 2, "keep.txt must carry its history from 1.0")

    def test_accepts_a_wrapped_archive_of_any_name(self):
        url = self.serve(wrapper="build-output-xyz")
        self.assert_success(self.tag(url))
        self.assertEqual(self.repo.tree("tags/1.1"), expected_tree(NEXT))

    def test_info_zip_archives_keep_non_ascii_names(self):
        # Info-ZIP's zip (macOS, Ubuntu) writes UTF-8 names without the UTF-8 flag.
        if not shutil.which("zip"):
            self.skipTest("Info-ZIP zip is not installed")
        source = tempfile.mkdtemp(dir=self.tmp)
        for rel, data in as_bytes(NEXT).items():
            if rel.endswith("/"):
                os.makedirs(os.path.join(source, rel), exist_ok=True)
            else:
                write(source, rel, data)
        built = os.path.join(self.tmp, "info-zip.zip")
        subprocess.run(["zip", "-qr", built, "."], cwd=source, check=True)
        with open(built, "rb") as handle:
            self.https.routes["/info-zip.zip"] = handle.read()
        self.assert_success(self.tag(f"{self.https.url}/info-zip.zip?sig={SIGNATURE}"))
        self.assertEqual(self.repo.tree("tags/1.1"), expected_tree(NEXT))

    def test_an_entry_with_two_names_is_rejected_before_any_write(self):
        # The header says src/café.php; an Info-ZIP Unicode Path field says
        # src/intended.php, which is what unzip extracts. zipfile before 3.12
        # ignores the field, so the action must check it itself, every field.
        for i, fields in enumerate((["src/intended.php"], ["src/café.php", "src/intended.php"])):
            with self.subTest(fields=fields):
                built = os.path.join(self.tmp, f"two-names-{i}.zip")
                with open(built, "wb") as handle:
                    handle.write(make_zip(NEXT))
                add_unicode_path_entry(built, "src/café.php".encode(), *fields)
                with open(built, "rb") as handle:
                    self.https.routes[f"/two-names-{i}.zip"] = handle.read()
                self.rejected(r"an entry has two different names",
                              WPORG_ZIP_URL=f"{self.https.url}/two-names-{i}.zip?sig={SIGNATURE}")

    def test_version_comes_from_the_plugin_header_not_the_filename(self):
        url = self.serve(path="/fixture-plugin.9.9.zip")
        result = self.tag(url)
        self.assert_success(result)
        self.assertEqual(result.outputs["version"], "1.1")

    def rejected(self, pattern, files=None, **env):
        head, before = self.repo.head(), self.frozen()
        result = self.tag(self.serve(files) if files is not None else None, **env)
        self.assert_failure(result, pattern)
        self.assertEqual(self.repo.head(), head, "a rejected release must not write anything")
        self.assertEqual(self.frozen(), before)
        return result

    def test_version_must_be_newer_than_stable(self):
        for version in ("1.0", "1.0.0", "01.0", "0.9", "0.10"):
            with self.subTest(version=version):
                self.rejected(r"not newer than the stable 1\.0", plugin(version))

    def test_artifact_readme_must_name_the_version_exactly(self):
        self.rejected(r"Stable Tag in the artifact readme\.txt is not 1\.1", plugin("1.1", stable="1.0"))
        self.rejected(r"Stable Tag in the artifact readme\.txt is not 1\.1", plugin("1.1", stable="1.1.0"))

    def test_prerelease_versions_are_rejected(self):
        self.rejected(r"not a numeric version", plugin("1.1-beta", stable="1.1-beta"))

    def test_first_releases_are_not_supported(self):
        self.repo.mucc("put", self.write_readme("trunk"), self.repo.url("trunk/readme.txt"))
        self.rejected(r"trunk/readme\.txt Stable Tag is not a numeric version")

    def write_readme(self, stable):
        path = self.repo.staging + f"/readme-{stable}.txt"
        with open(path, "w") as handle:
            handle.write(plugin("1.0", stable=stable)["readme.txt"])
        return path

    def test_stable_tag_directory_must_exist(self):
        self.repo.mucc("put", self.write_readme("0.9"), self.repo.url("trunk/readme.txt"))
        self.rejected(r"tags/0\.9 does not exist")

    def test_existing_destination_is_never_reused(self):
        self.repo.put_tree("tags/1.1", plugin("1.1"))
        existing = self.repo.tree("tags/1.1")
        self.rejected(r"tags/1\.1 already exists")
        self.assertEqual(self.repo.tree("tags/1.1"), existing)

    def test_equivalent_spelling_of_the_destination_counts_as_existing(self):
        self.repo.put_tree("tags/1.1.0", plugin("1.1.0", stable="1.1.0"))
        self.rejected(r"tags/1\.1 already exists")

    def test_unsafe_archives_cause_zero_writes(self):
        for name, files in (("traversal", {**NEXT, "../evil.php": "x"}),
                            ("vcs metadata", {**NEXT, ".svn/wc.db": "x"}),
                            ("two plugins", {**NEXT, "other.php": "<?php\n/*\n * Plugin Name: Other\n */\n"}),
                            ("no readme", {k: v for k, v in NEXT.items() if k != "readme.txt"})):
            with self.subTest(name=name):
                self.rejected(r"error: ", files)

    def test_content_transforming_source_properties_are_rejected(self):
        for prop, target in (("svn:eol-style", "tags/1.0/keep.txt"), ("svn:keywords", "tags/1.0/src/a.php"),
                             ("svn:externals", "tags/1.0/src"), ("svn:special", "tags/1.0/keep.txt")):
            with self.subTest(prop=prop):
                value = {"svn:externals": "lib https://example.invalid/lib", "svn:special": "*"}.get(prop, "native")
                self.repo.mucc("propset", prop, value, self.repo.url(target))
                self.rejected(prop)
                self.repo.mucc("propdel", prop, self.repo.url(target))

    def test_properties_carried_by_the_copy_that_made_the_stable_tag_are_rejected(self):
        self.repo.mucc("propset", "svn:keywords", "Id", self.repo.url("trunk/src/a.php"))
        self.repo.mucc("rm", self.repo.url("tags/1.0"), "cp", "HEAD", self.repo.url("trunk"), self.repo.url("tags/1.0"))
        self.rejected("svn:keywords")

    def test_download_must_be_https(self):
        self.rejected(r"zip-url must be an https:// URL", WPORG_ZIP_URL="http://127.0.0.1/release.zip")

    def test_redirects_to_plain_http_are_refused(self):
        def redirect(handler):
            handler.send_response(302)
            handler.send_header("Location", "http://127.0.0.1:9/release.zip")
            handler.end_headers()

        self.https.routes["/redirect.zip"] = redirect
        self.rejected(r"downloading zip-url failed", WPORG_ZIP_URL=f"{self.https.url}/redirect.zip?sig={SIGNATURE}")

    def test_untrusted_certificates_are_refused(self):
        url = self.serve()
        self.rejected(r"downloading zip-url failed", WPORG_ZIP_URL=url, CURL_CA_BUNDLE=None)

    def test_missing_artifact_fails(self):
        self.rejected(r"downloading zip-url failed \(HTTP 404\)",
                      WPORG_ZIP_URL=f"{self.https.url}/missing.zip?sig={SIGNATURE}")

    def test_curl_runs_under_a_file_size_limit(self):
        # curl before 8.4 ignores --max-filesize when the server sends no length.
        seen = os.path.join(self.tmp, "ulimit")
        self.wrap("curl", f'bash -c "ulimit -f" > \'{seen}\'\nexec "$NEXT" "$@"')
        self.assert_success(self.tag())
        with open(seen) as handle:
            self.assertEqual(int(handle.read()), 256 * 1024 + 1, "in 1 KiB blocks")

    def test_downloads_past_the_size_limit_are_named(self):
        # Simulated: serving 256 MiB is too slow for a test. 63 is curl's own
        # --max-filesize exit; 153 is the SIGXFSZ kill from the file size limit.
        for status in (63, 153):
            with self.subTest(status=status):
                self.wrap("curl", f"exit {status}")
                self.rejected(r"downloading zip-url failed: the ZIP is larger than 256 MiB")

    def test_credentials_never_reach_the_artifact_host(self):
        self.assert_success(self.tag())
        for request in self.https.requests:
            headers = {k.lower(): v for k, v in request["headers"].items()}
            self.assertNotIn("authorization", headers)
            self.assertNotIn("fixture-user", repr(request))


if __name__ == "__main__":
    unittest.main()
