"""Shared paths, fixtures and the action runner for the wporg-svn tests.

Every SVN write here goes to a throwaway file:// repository, and the write
guard (guard/bin) sits first on PATH for every subprocess, hooks included.
"""

import atexit
import http.server
import io
import json
import os
import pathlib
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
import xml.etree.ElementTree as ET
import zipfile

TESTS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(TESTS))
ACTIONS = os.path.join(REPO, ".github", "actions", "wporg-svn")
LIB = os.path.join(ACTIONS, "lib")
GUARD_BIN = os.path.join(TESTS, "guard", "bin")

sys.path.insert(0, LIB)

SLUG = "fixture-plugin"
USERNAME = "fixture-user"
# Sentinels: neither may ever appear in anything an action prints or writes.
PASSWORD = "sentinel-password-7c1e"
SIGNATURE = "sentinel-signature-93ab"

README = """=== Fixture Plugin ===
Contributors: fixture
Requires at least: 6.0
Tested up to: 6.6
Stable tag: {stable}
License: GPLv2

A fixture.

== Changelog ==

= {version} =
* Release {version}.
"""

PHP = """<?php
/**
 * Plugin Name: Fixture Plugin
 * Version: {version}
 */
"""


def base_env(home):
    """A clean environment: write guard first on PATH, private HOME, C locale.

    GitHub and runner variables are dropped so a test run inside CI can never
    write to the job's own outputs or pick up its settings.
    """
    env = {k: v for k, v in os.environ.items() if not k.startswith(("GITHUB_", "RUNNER_", "WPORG_", "CURL_"))}
    env.update(PATH=GUARD_BIN + os.pathsep + os.environ["PATH"], HOME=home, LC_ALL="C.UTF-8")
    return env


def write(root, rel, data):
    """Write bytes (or text) to root/rel, creating parent directories."""
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data.encode() if isinstance(data, str) else data)
    return path


def plugin(version, stable=None, extra=None):
    """A minimal plugin as {relative path: content}; directories end with '/'."""
    files = {
        "readme.txt": README.format(stable=stable or version, version=version),
        "fixture-plugin.php": PHP.format(version=version),
    }
    files.update(extra or {})
    return files


def as_bytes(files):
    return {k: (v.encode() if isinstance(v, str) else v) for k, v in files.items()}


def make_zip(files, wrapper=None):
    """ZIP bytes for files ({path: content}, directories end with '/')."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel, data in as_bytes(files).items():
            name = f"{wrapper}/{rel}" if wrapper else rel
            zf.writestr(name, b"" if data is None else data)
    return buffer.getvalue()


def expected_tree(files):
    """The read_tree() of files once written to disk."""
    root = tempfile.mkdtemp()
    try:
        for rel, data in as_bytes(files).items():
            if rel.endswith("/"):
                os.makedirs(os.path.join(root, rel), exist_ok=True)
            else:
                write(root, rel, data)
        return read_tree(root)
    finally:
        shutil.rmtree(root)


def read_tree(root):
    """{relative path: bytes} for files, {relative dir + '/': None} for directories."""
    tree = {}
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        if rel == ".":
            dirnames[:] = [d for d in dirnames if d != ".svn"]
        for name in dirnames:
            tree[os.path.normpath(os.path.join(rel, name)) + "/"] = None
        for name in filenames:
            with open(os.path.join(dirpath, name), "rb") as handle:
                tree[os.path.normpath(os.path.join(rel, name))] = handle.read()
    return tree


class Repo:
    """A throwaway SVN repository laid out like a wordpress.org plugin."""

    def __init__(self, workdir, env, slug=SLUG, create=True):
        self.env = env
        self.dir = os.path.join(workdir, "repo")
        self.staging = os.path.join(workdir, "staging")
        self.root = pathlib.Path(self.dir).as_uri()
        self.base = f"{self.root}/{slug}"
        if create:
            os.makedirs(self.staging)
            subprocess.run(["svnadmin", "create", self.dir], check=True, env=env)
            self.mucc("mkdir", self.base, "mkdir", self.url("trunk"), "mkdir", self.url("tags"),
                      "mkdir", self.url("assets"))

    def url(self, path=""):
        return f"{self.base}/{path}" if path else self.base

    def svn(self, *args, check=True):
        result = subprocess.run(["svn", "--non-interactive", *args], env=self.env, capture_output=True)
        if check and result.returncode:
            raise AssertionError(result.stderr.decode())
        return result.stdout

    def mucc(self, *actions, message="fixture"):
        result = subprocess.run(["svnmucc", "--non-interactive", "-m", message, *actions], env=self.env,
                                capture_output=True, text=True, check=True)
        return int(re.match(r"r(\d+) committed", result.stdout).group(1))

    def head(self):
        return int(self.svn("info", "--show-item", "revision", self.root).decode().strip())

    def put_tree(self, path, files, message="fixture"):
        """Create path (which must not exist) holding files."""
        actions = ["mkdir", self.url(path)]
        dirs = sorted({os.path.dirname(rel.rstrip("/")) for rel in files} | {rel.rstrip("/") for rel in files
                                                                            if rel.endswith("/")})
        for rel in sorted(dirs, key=lambda d: d.count("/")):
            parts = rel.split("/") if rel else []
            for depth in range(1, len(parts) + 1):
                sub = "/".join(parts[:depth])
                if self.url(f"{path}/{sub}") not in actions:
                    actions += ["mkdir", self.url(f"{path}/{sub}")]
        for rel, data in sorted(as_bytes(files).items()):
            if rel.endswith("/"):
                continue
            local = tempfile.mktemp(dir=self.staging)
            with open(local, "wb") as handle:
                handle.write(data)
            actions += ["put", local, self.url(f"{path}/{rel}")]
        return self.mucc(*actions, message=message)

    def seed(self, stable="1.0", files=None):
        """trunk and tags/<stable> hold the same release; assets holds a banner."""
        self.put_tree("trunk-new", files or plugin(stable))
        self.mucc("rm", self.url("trunk"), "mv", self.url("trunk-new"), self.url("trunk"))
        self.mucc("put", write(self.staging, "banner.png", b"\x89PNG banner"), self.url("assets/banner.png"))
        return self.mucc("cp", "HEAD", self.url("trunk"), self.url(f"tags/{stable}"))

    def tree(self, path, rev="HEAD"):
        dest = tempfile.mktemp(dir=self.staging)
        self.svn("export", "-q", "--ignore-externals", "-r", str(rev), f"{self.url(path)}@{rev}", dest)
        try:
            return read_tree(dest)
        finally:
            shutil.rmtree(dest)

    def cat(self, path, rev="HEAD"):
        return self.svn("cat", "-r", str(rev), f"{self.url(path)}@{rev}")

    def last_changed(self, path, rev="HEAD"):
        return int(self.svn("info", "--show-item", "last-changed-revision", f"{self.url(path)}@{rev}").decode())

    def exists(self, path, rev="HEAD"):
        return self.svn("info", f"{self.url(path)}@{rev}", check=False) != b""

    def props(self, path, rev="HEAD"):
        """{relative path: {name: value}} for every node under path."""
        target = self.url(path)
        doc = ET.fromstring(self.svn("proplist", "-R", "-v", "--xml", "-r", str(rev), f"{target}@{rev}"))
        found = {}
        for node in doc.iter("target"):
            rel = node.get("path")[len(target):].lstrip("/")
            found[rel] = {p.get("name"): p.text or "" for p in node.iter("property")}
        return found

    def changed(self, rev):
        """Sorted (action, path) pairs committed in rev."""
        doc = ET.fromstring(self.svn("log", "-v", "--xml", "-r", str(rev), self.root))
        return sorted((p.get("action"), p.text) for p in doc.iter("path"))

    def hook(self, name, body):
        """Install a repository hook; hooks run with an empty environment."""
        exports = "".join(f"export {k}='{self.env[k]}'\n" for k in ("PATH", "HOME", "LC_ALL"))
        path = os.path.join(self.dir, "hooks", name)
        with open(path, "w") as handle:
            handle.write("#!/bin/sh\n" + exports + body)
        os.chmod(path, 0o755)


_CERT = {}


def certificate():
    """A self-signed certificate for 127.0.0.1, created once per test run."""
    if not _CERT:
        folder = tempfile.mkdtemp()
        atexit.register(shutil.rmtree, folder, True)
        cert, key = os.path.join(folder, "cert.pem"), os.path.join(folder, "key.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
                        "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
                       check=True, capture_output=True)
        _CERT.update(cert=cert, key=key)
    return _CERT["cert"], _CERT["key"]


class Https:
    """A local HTTPS server. routes: path -> bytes, or callable(handler)."""

    def __init__(self):
        self.routes, self.requests = {}, []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                owner.requests.append({"path": self.path, "headers": dict(self.headers)})
                route = owner.routes.get(self.path.split("?")[0])
                if route is None:
                    self.send_error(404)
                elif callable(route):
                    route(self)
                else:
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(route)))
                    self.end_headers()
                    self.wfile.write(route)

            def log_message(self, *args):
                pass

        cert, key = certificate()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"https://127.0.0.1:{self.server.server_address[1]}"
        self.ca = cert

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Result:
    def __init__(self, process, outputs, summary):
        self.code = process.returncode
        self.stdout, self.stderr = process.stdout, process.stderr
        self.log = process.stdout + process.stderr
        self.outputs, self.summary = outputs, summary


class ActionTest(unittest.TestCase):
    """Runs the real action scripts against a throwaway repository."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "home")
        self.scratch = os.path.join(self.tmp, "scratch")  # the actions' TMPDIR
        os.makedirs(self.home)
        os.makedirs(self.scratch)
        self.env = base_env(self.home)
        self.repo = Repo(self.tmp, self.env)
        self._https = None

    @property
    def https(self):
        if self._https is None:
            self._https = Https()
            self.addCleanup(self._https.close)
        return self._https

    def action_env(self, **env):
        merged = dict(self.env, WPORG_SVN_TEST_ROOT=self.repo.root, WPORG_SLUG=SLUG, WPORG_USERNAME=USERNAME,
                      WPORG_PASSWORD=PASSWORD, TMPDIR=self.scratch,
                      GITHUB_OUTPUT=os.path.join(self.tmp, "github-output"),
                      GITHUB_STEP_SUMMARY=os.path.join(self.tmp, "github-summary"),
                      WRITE_GUARD_LOG=os.path.join(self.tmp, "svn-calls.jsonl"))
        if self._https:
            merged["CURL_CA_BUNDLE"] = self._https.ca
        merged.update(env)
        return {k: v for k, v in merged.items() if v is not None}

    def wrap(self, tool, body):
        """Put a test-only wrapper for tool first on the actions' PATH.

        The body runs under sh; "$NEXT" is the guarded tool it may exec.
        """
        folder = os.path.join(self.tmp, "wrappers")
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, tool)
        nxt = os.path.join(GUARD_BIN, tool) if tool in ("svn", "svnmucc", "svnrdump") else shutil.which(tool)
        with open(path, "w") as handle:
            handle.write(f"#!/bin/sh\nNEXT='{nxt}'\n{body}\n")
        os.chmod(path, 0o755)
        self.env["PATH"] = folder + os.pathsep + self.env["PATH"].replace(folder + os.pathsep, "")

    def start(self, action, **env):
        """Start an action without waiting; it leads its own process group."""
        for name in ("github-output", "github-summary"):
            open(os.path.join(self.tmp, name), "w").close()
        script = os.path.join(ACTIONS, action, f"{action}.sh")
        return subprocess.Popen(["bash", script], env=self.action_env(**env), stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, start_new_session=True)

    def finish(self, process, timeout=180):
        stdout, stderr = process.communicate(timeout=timeout)
        process.stdout, process.stderr = stdout, stderr
        with open(os.path.join(self.tmp, "github-output")) as handle:
            outputs = dict(line.rstrip("\n").split("=", 1) for line in handle if "=" in line)
        with open(os.path.join(self.tmp, "github-summary")) as handle:
            summary = handle.read()
        result = Result(process, outputs, summary)

        # Invariants for every run, successful or not.
        self.assertEqual(os.listdir(self.scratch), [], "the action left temporary files behind")
        everything = result.log + summary + repr(outputs)
        for secret in (PASSWORD, SIGNATURE):
            self.assertNotIn(secret, everything, "a secret leaked into the action's output")
        self.assertNotRegex(everything, r"(?m)^::(?!error|warning|notice|add-mask)",
                            "unexpected workflow command")
        return result

    def svn_calls(self):
        """Every svn/svnmucc argv the actions ran, in order."""
        path = os.path.join(self.tmp, "svn-calls.jsonl")
        if not os.path.exists(path):
            return []
        with open(path) as handle:
            return [json.loads(line) for line in handle]

    def run_action(self, action, **env):
        return self.finish(self.start(action, **env))

    def assert_success(self, result):
        self.assertEqual(result.code, 0, result.log)

    def assert_failure(self, result, pattern):
        self.assertNotEqual(result.code, 0, result.log)
        self.assertRegex(result.log, pattern)
        self.assertEqual(result.outputs, {}, "a failed action must not expose outputs")
