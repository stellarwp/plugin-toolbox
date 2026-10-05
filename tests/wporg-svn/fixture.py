#!/usr/bin/env python3
"""The end-to-end fixture for CI: a file:// plugin repository at release 1.0,
and a local HTTPS host serving the 1.1 ZIP. Nothing here talks to wordpress.org.

Usage:
  fixture.py up DIR           create the fixture in DIR, write DIR/env (KEY=value
                              lines for $GITHUB_ENV), then serve until killed
  fixture.py check DIR VERSION  exit 0 when tags/VERSION and trunk both match the
                              artifact and trunk's Stable Tag is VERSION
"""

import os
import sys
import time

import support
from test_tag import NEXT, STABLE


def up(folder):
    home = os.path.join(folder, "home")
    os.makedirs(home)
    repo = support.Repo(folder, support.base_env(home))
    repo.seed("1.0", STABLE)
    https = support.Https()
    https.routes["/release.zip"] = support.make_zip(NEXT, wrapper="fixture-plugin")
    with open(os.path.join(folder, "env.tmp"), "w") as handle:
        handle.write(f"WPORG_SVN_TEST_ROOT={repo.root}\n"
                     f"CURL_CA_BUNDLE={https.ca}\n"
                     f"FIXTURE_ZIP_URL={https.url}/release.zip?sig=fixture\n")
    os.rename(os.path.join(folder, "env.tmp"), os.path.join(folder, "env"))
    while True:
        time.sleep(3600)


def check(folder, version):
    repo = support.Repo(folder, support.base_env(os.path.join(folder, "home")), create=False)
    expected = support.expected_tree(NEXT)
    problems = [path for path in (f"tags/{version}", "trunk") if repo.tree(path) != expected]
    if b"Stable tag: " + version.encode() not in repo.cat("trunk/readme.txt"):
        problems.append("trunk/readme.txt Stable Tag")
    print("end state ok" if not problems else "end state wrong: " + ", ".join(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["up"] and len(sys.argv) == 3:
        up(sys.argv[2])
    elif sys.argv[1:2] == ["check"] and len(sys.argv) == 4:
        sys.exit(check(sys.argv[2], sys.argv[3]))
    else:
        sys.exit(__doc__)
