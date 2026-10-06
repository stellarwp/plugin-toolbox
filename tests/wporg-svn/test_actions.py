"""The action.yml files wire inputs, scripts and outputs together correctly.

actionlint checks the syntax; this checks the contract with the scripts, which
no linter knows about. The files are read as text: they are ours and simple.
"""

import os
import re
import unittest

from support import ACTIONS

CREDENTIALS = {"wporg-username": "WPORG_USERNAME", "wporg-password": "WPORG_PASSWORD"}
EXPECTED = {"expected-revision": "WPORG_EXPECTED_REVISION"}
OPTIONAL = set(EXPECTED)
ACTIONS_SPEC = {
    "tag": ({"plugin-slug": "WPORG_SLUG", "zip-url": "WPORG_ZIP_URL", **CREDENTIALS},
            {"version", "revision", "previous-stable"}),
    "set-stable": ({"plugin-slug": "WPORG_SLUG", "version": "WPORG_VERSION", **EXPECTED, **CREDENTIALS},
                   {"version", "revision"}),
    "update-trunk": ({"plugin-slug": "WPORG_SLUG", "version": "WPORG_VERSION", **EXPECTED, **CREDENTIALS},
                     {"version", "revision"}),
}


def block(text, key):
    """The lines under a top-level key, up to the next top-level key."""
    match = re.search(rf"(?ms)^{key}:\n(.*?)(?=^\S|\Z)", text)
    return match.group(1) if match else ""


def named(section):
    """{name: its indented body} for the two-space-indented keys of a section."""
    parts = re.split(r"(?m)^  ([a-z-]+):\n", section)
    return dict(zip(parts[1::2], parts[2::2]))


class ActionMetadataTest(unittest.TestCase):
    def read(self, *path):
        with open(os.path.join(*path)) as handle:
            return handle.read()

    def test_each_action_matches_its_script(self):
        # The integration tests prove the scripts read exactly these env names.
        for action, (inputs, outputs) in ACTIONS_SPEC.items():
            with self.subTest(action=action):
                text = self.read(ACTIONS, action, "action.yml")
                script = self.read(ACTIONS, action, f"{action}.sh")
                declared = named(block(text, "inputs"))
                self.assertEqual(set(declared), set(inputs))
                for name, body in declared.items():
                    self.assertIn("required: false" if name in OPTIONAL else "required: true", body, name)

                self.assertRegex(text, r"(?m)^  using: composite$")
                steps = block(text, "runs")
                self.assertEqual(steps.count("shell: bash"), steps.count("run:"), "every step needs shell: bash")
                for run in re.findall(r"run: (.*)", steps):
                    self.assertNotIn("${{", run, "inputs reach scripts through env, never the script text")
                self.assertIn(f'run: bash "$GITHUB_ACTION_PATH/{action}.sh"', steps)

                main = steps[steps.index("id: release"):]
                for name, variable in inputs.items():
                    self.assertIn(f"{variable}: ${{{{ inputs.{name} }}}}", main)

                declared_outputs = named(block(text, "outputs"))
                self.assertEqual(set(declared_outputs), outputs)
                emitted = set(re.findall(r"^output ([a-z-]+) ", script, re.M))
                self.assertEqual(emitted, outputs)
                for name, body in declared_outputs.items():
                    self.assertIn(f"value: ${{{{ steps.release.outputs.{name} }}}}", body)

    def test_the_zip_url_and_password_are_masked_first(self):
        for action in ACTIONS_SPEC:
            with self.subTest(action=action):
                steps = block(self.read(ACTIONS, action, "action.yml"), "runs")
                self.assertLess(steps.index("::add-mask::"), steps.index("id: release"))
                self.assertIn("${{ inputs.wporg-password }}", steps[:steps.index("id: release")])
                if action == "tag":
                    self.assertIn("${{ inputs.zip-url }}", steps[:steps.index("id: release")])

    def test_the_readme_example_is_the_linted_example_file(self):
        readme = self.read(ACTIONS, "README.md")
        example = self.read(ACTIONS, "examples", "release.yml")
        self.assertIn("```yaml\n" + example + "```\n", readme, "README example drifted from examples/release.yml")


if __name__ == "__main__":
    unittest.main()
