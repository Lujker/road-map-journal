# Updating an installed skill

First identify the installation scope, selected agents, installed revision and any local changes. Back up or reconcile local edits before replacing files. Reinstalling with `skills add` and `--copy` can **overwrite** the selected target; never run a broad update assuming it affects only one agent or preserves customizations. For a targeted global Codex copy, for example:

```sh
npx skills add Lujker/road-map-journal --skill road-map-journal --agent codex --global --copy --yes
```

This selects Codex only; it does not update other agents or environments. Inspect the complete installed skill and `references/`, check for duplicates and verify discovery using the host's own mechanism. For other agents use their documented name and intended scope; `--global` is optional and must not be assumed for project-scoped installations. Changed-version reinstalls and one targeted `skills update` with a prepared GitHub lock were verified in isolated WSL homes; these do not establish update behavior on every host. In one isolated `skills` 1.7.6 probe, `owner/repo@<commit>` printed the requested old commit but installed current content instead; verify actual files and do not assume ref pinning works for that version. Installation and file equality alone do not prove runtime behavior.

## Optional per-host update script

`scripts/update-installed.mjs` wraps the targeted command above for **one host**: it reports where the skill is installed (canonical `.agents` copy, Claude/Codex/Hermes links, account-synced Claude copies), compares the installed content with the published version, and, only with `--apply`, backs up the existing copies, runs the pinned `skills` CLI for the selected agents, and verifies the result. It stops on locally modified or untracked installs unless `--force` is given. It requires Node 22.20 or newer (the `skills` CLI requirement) and Git. Run it with a new-enough `node`; on a host where an older Node comes first in `PATH`, call that binary explicitly.

```sh
node scripts/update-installed.mjs            # report only
node scripts/update-installed.mjs --apply    # back up, update, verify
node --test scripts/update-installed.test.mjs
```

To run it without keeping a checkout, an agent or a person can fetch it temporarily (use a Node 22.20+ binary):

```sh
D=$(mktemp -d) && git clone --depth 1 https://github.com/Lujker/road-map-journal.git "$D/r" && node "$D/r/scripts/update-installed.mjs"   # add --apply after reading the report
rm -rf "$D"
```

Updating is a manual, per-host action by design: there is no background or scheduled updater, and the script does not wait for running agent sessions. Skill files are instructions, so replacing them under an open session is allowed, but a session may keep the old text until it reloads or restarts.

It does not update copies the `skills` CLI does not manage, such as skills synced from a Claude account (reported only), and it does not reload an already running agent session. Use `--agent <id>` to choose agents; Hermes is not selected by default because the CLI would create a root Hermes link that can hide a categorised one. Model-free tests in isolated homes on WSL and Windows (Node 26) covered report-only, an outdated pristine install, and a locally edited install; hosts and customized installs beyond those are untested.

