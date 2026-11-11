# push-translations

Pushes a plugin's POT file to the shared GlotPress site, translations.stellarwp.com, and imports
its strings into a project. What the import printed comes back as an output.

The Events Calendar, a project at the top level of the site:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/push-translations@v1
  id: translations
  with:
    project: the-events-calendar
    pot-path: lang/the-events-calendar.pot
    remote-folder: tec
    host: ${{ secrets.TRANSLATIONS_DEPLOY_HOST }}
    user: ${{ secrets.TRANSLATIONS_DEPLOY_USER }}
    ssh-key: ${{ secrets.TRANSLATIONS_DEPLOY_SSH_KEY }}
    pot-location: ${{ secrets.TRANSLATIONS_DEPLOY_POT_LOCATION }}

- run: echo "$RESULT"
  env:
    RESULT: ${{ steps.translations.outputs.glotpress-result }}
```

GiveWP, a project under a parent, with a folder of its own on the server:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/push-translations@v1
  with:
    project: givewp/give
    pot-path: languages/give.pot
    remote-folder: givewp
    host: ${{ secrets.TRANSLATIONS_DEPLOY_HOST }}
    user: ${{ secrets.TRANSLATIONS_DEPLOY_USER }}
    ssh-key: ${{ secrets.TRANSLATIONS_DEPLOY_SSH_KEY }}
    pot-location: ${{ secrets.TRANSLATIONS_DEPLOY_POT_LOCATION }}
```

A composite action cannot read secrets, so the caller passes them. Generate the POT before this
step: the action only sends the file.

## What it does

1. Checks every input and names the build: a random id of 32 hex characters.
2. Copies the POT to `<pot-location>/<remote-folder>/` with rsync, under the name it has in the
   repository.
3. Over ssh, in `site-directory`, runs
   `wp glotpress import-originals <project> <pot-location>/<remote-folder>/<file>.pot` and writes
   what it prints to `bot-output/<file>-<build id>`.
4. Reads that file back from `result-url` over https, sets it as `glotpress-result` and adds it to
   the job summary.
5. Deletes the file from the server. This runs even when the import or the read failed, so the
   output does not stay public.

The build id is random, not derived from the commit, so the address of the output cannot be
guessed while the file exists.

## What the server needs

- The `user` can log in with `ssh-key`, and its public key is in `authorized_keys`.
- `rsync` on the server, and `<pot-location>` existing and writable. rsync creates
  `<remote-folder>` when it is missing, not the directories above it.
- WP-CLI as `wp` on the path of a non-interactive shell, and the GlotPress site in
  `site-directory`, with the `glotpress import-originals` command.
- The project exists in GlotPress. The import does not create one.
- `site-directory/bot-output/` is served at `result-url`. The action creates the directory.

## What it refuses

Before anything is sent, with the input named in the message:

- An empty `project`, `pot-path`, `remote-folder`, `host`, `user`, `ssh-key` or `pot-location`. A
  secret the repository does not have arrives empty, so this is how a missing secret shows.
- Any path whose parts are not letters, digits, `.`, `_` and `-`, or that has a part starting with
  `.` or `-`. That rules out spaces, quotes, `;`, `|`, `$`, backticks, `..`, `~` and a value that
  would be read as a command option.
- `project` or `remote-folder` that starts with `/`.
- `pot-path` that is absolute or does not end in `.pot`.
- `pot-location` that is not absolute.
- `host` that is not a host name or an IPv4 address, and `user` that is not a plain user name.
- `result-url` that is not `https://`, or that has a query, a port or credentials.

A refused `host`, `user` or `pot-location` is named without its value, since it comes from a
secret.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `project` | yes | | The GlotPress project path: `the-events-calendar`, `givewp/give` |
| `pot-path` | yes | | The POT file, relative to the workspace |
| `remote-folder` | yes | | The folder under `pot-location` the POT is copied to: `tec`, `givewp` |
| `host` | yes | | The server to connect to |
| `user` | yes | | The user to connect as |
| `ssh-key` | yes | | The private key of `user` |
| `pot-location` | yes | | The directory on the server that holds the POT folders, absolute |
| `site-directory` | no | `translations.stellarwp.com/html/` | The GlotPress site on the server, absolute or relative to the home of `user` |
| `result-url` | no | `https://translations.stellarwp.com/bot-output/` | The public URL of `bot-output/` in `site-directory` |

A trailing `/` on a folder, a directory or the URL is optional.

## Outputs

| Output | Example | What it is |
|---|---|---|
| `glotpress-result` | `1 new strings added, 0 updated, 0 fuzzied, and 0 obsoleted.` | What `wp glotpress import-originals` printed. Text from the server: pass it to a script through `env`, never inside `run:` |
| `project` | `givewp/give` | The project the strings were imported into |

## How it runs

Two [actions/github-script](https://github.com/actions/github-script) steps run
[`push-translations.js`](./push-translations.js). The first checks the inputs and sets the values
the later steps use. The second reads the import output back over https and sets it as the
`glotpress-result` output. Inputs reach both through `process.env`, never by being interpolated.

The copy and the two ssh steps are third-party actions,
[burnett01/rsync-deployments](https://github.com/Burnett01/rsync-deployments) and
[appleboy/ssh-action](https://github.com/appleboy/ssh-action), pinned to a full commit SHA because
they receive the deploy key. The rsync action builds a shell command from the paths, the host and
the user, which is why all of them are checked. The remote script holds no value: the checked
values reach the remote shell as environment variables, through the ssh action's `envs`.

`tests/actions/push-translations/push-translations.test.js` covers the check, with the two shapes
above and the refusals, and the read of the import output. Run `npm install` once, then `node --test`.
