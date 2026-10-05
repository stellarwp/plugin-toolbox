"""tag: copy the stable tag to tags/<version> server-side, then make it match the ZIP exactly."""

import unittest

from support import ActionTest, SIGNATURE, SLUG, expected_tree, make_zip, plugin

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

        copy, revision = int(result.outputs["copy-revision"]), int(result.outputs["revision"])
        self.assertEqual(result.outputs["version"], "1.1")
        self.assertEqual(result.outputs["previous-stable"], "1.0")
        self.assertEqual((copy, revision), (snapshot + 1, snapshot + 2))
        self.assertEqual(self.repo.tree("tags/1.1"), expected_tree(NEXT))
        self.assertEqual(self.frozen(), before, "trunk, the stable tag and assets must not change")

        self.assertEqual(self.repo.changed(copy), [("A", f"/{SLUG}/tags/1.1")])
        self.assertTrue(all(path.startswith(f"/{SLUG}/tags/1.1/") for _, path in self.repo.changed(revision)))
        log = self.repo.svn("log", "-v", "--xml", "-r", str(copy), self.repo.root).decode()
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

    def test_only_the_new_tag_is_checked_out(self):
        result = self.tag()
        self.assert_success(result)
        checkouts = [call for call in self.svn_calls() if "checkout" in call or "co" in call]
        self.assertEqual(len(checkouts), 1)
        copy = result.outputs["copy-revision"]
        self.assertIn(f"{self.repo.url('tags/1.1')}@{copy}", checkouts[0])
        self.assertIn("--ignore-externals", checkouts[0])

    def test_stable_tag_properties_are_read_in_one_stream(self):
        # svn proplist -R on a URL asks for every path separately: minutes on a large tag.
        snapshot = self.repo.head()
        self.assert_success(self.tag())
        dumps = [call for call in self.svn_calls() if call[0] == "svnrdump"]
        self.assertEqual(len(dumps), 1)
        self.assertIn("dump", dumps[0])
        self.assertEqual(dumps[0][-1], self.repo.url("tags/1.0"))
        self.assertEqual(dumps[0][dumps[0].index("-r") + 1], str(snapshot))
        remote = [call for call in self.svn_calls() if "proplist" in call and any(a.startswith("file:") for a in call)]
        self.assertEqual(remote, [])

    def test_unchanged_files_keep_their_history(self):
        self.assert_success(self.tag())
        log = self.repo.svn("log", "-q", self.repo.url("tags/1.1/keep.txt")).decode()
        self.assertGreaterEqual(log.count("\nr"), 2, "keep.txt must carry its history from 1.0")

    def test_accepts_a_wrapped_archive_of_any_name(self):
        url = self.serve(wrapper="build-output-xyz")
        self.assert_success(self.tag(url))
        self.assertEqual(self.repo.tree("tags/1.1"), expected_tree(NEXT))

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

    def test_credentials_never_reach_the_artifact_host(self):
        self.assert_success(self.tag())
        for request in self.https.requests:
            headers = {k.lower(): v for k, v in request["headers"].items()}
            self.assertNotIn("authorization", headers)
            self.assertNotIn("fixture-user", repr(request))


if __name__ == "__main__":
    unittest.main()
