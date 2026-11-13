# Developing roadctl

For people and agents who change [`scripts/roadctl.mjs`](../scripts/roadctl.mjs) or add to it. Users of roadctl do not need this page; see [roadctl.md](roadctl.md).

## The rule

1. **New parts go into modules, not into the shared file.** A new command, a new area (a run ledger, a doctor, a summary) is a file in [`scripts/roadctl/`](../scripts/roadctl/) with its own test file next to it (`scripts/roadctl/<name>.test.mjs`). Old code is not rewritten or reorganised on the way.
2. **The shared file is edited by one executor at a time.** `scripts/roadctl.mjs` (and `scripts/roadctl.test.mjs`) change only for a fix of old behaviour, or to extend a seam below. Two executors working in parallel each work in their own module and test file; when one of them needs an edit of the shared file, it waits for its turn (order of acceptance) and keeps that edit small. Each executor works in its own git worktree.
3. **Old tests keep their expectations.** A change that needs an old test edited is a behaviour change: say so and get it accepted separately.
4. Node standard library only, no build step, no dependency.

Files that do not conflict with code work and may be edited in parallel: `examples/scheduler/`, docs, the skill, `scripts/update-installed.mjs`, CI.

## Seams (what a module may use)

A module is the default export of `scripts/roadctl/<name>.mjs`: [`registry.mjs`](../scripts/roadctl/registry.mjs) describes the shape and validates it. [`index.mjs`](../scripts/roadctl/index.mjs) lists the modules (one import and one array entry per module; append at the end). [`probe.mjs`](../scripts/roadctl/probe.mjs) is the smallest example.

| Seam | Declared by the module | Where it plugs into roadctl.mjs |
| --- | --- | --- |
| Command and its help | `commands: { name: { group, effect, summary, purpose, usage, flags, examples, changes, exits, run(ctx), hidden? } }` | merged into `ALL_COMMANDS` (the built-in table stays `COMMANDS`); `main()` runs `run(ctx)` and uses its return value as the exit code; `help`, `help <name>` and `<name> --help` read `ALL_COMMANDS`; `hidden: true` keeps a command out of the overview |
| Card header keys | `headerKeys: ['run_id']` | added to `KNOWN_KEYS`, so lint does not warn `unknown key` |
| `tick` hook | `tick(ctx)` | one call in `tickCommand`, after the decision is made and the ledger line is written, before output; no-op without hooks |
| Helpers | `ctx.api` (`findBoard`, `loadBoard`, `knownBoards`, `hasBoardSources`, `loadRegistry`, `sanitize`, `today`, `lint`, `VERSION`) | `moduleApi()` in roadctl.mjs; a module does not import roadctl.mjs. Adding a helper is an edit of the shared file |

Contract details:

- A command name must not exist already (built-in or another module); a header key must not be known already. A clash stops roadctl at start with a message naming the module, so it cannot silently change old behaviour.
- `run(ctx)` gets `{ flags, args, io, out, env, api, modules }` and returns the exit code (a thrown error is printed as `roadctl: ...` with exit 2, like built-in commands). Keep the effect mark (`read`, `write`, `git`) true: a test runs every help.
- The tick hook gets copies of `{ agent, decision, limits, items, sync, boardDirs }` plus `env` and `api`. It observes: it cannot change the decision, the output or the exit code, and a hook that throws only prints a warning on stderr. It is not called when tick was busy or failed before deciding.
- Modules have no side effects at import. A module that fails to load stops roadctl with the error (a copy without the whole `roadctl/` folder still runs the built-in commands).
- Keep the `roadctl help` overview about one screen (a test caps it at 70 lines): use `hidden: true` for internal commands, and mind the budget before adding visible ones.
- A visible module command must appear in the overview (automatic) and in [roadctl.md](roadctl.md) (`roadctl <name>`); the test "help and docs" in `scripts/roadctl/registry.test.mjs` checks both for every module command.

## Adding a module

1. `scripts/roadctl/<name>.mjs` with the default export; `scripts/roadctl/<name>.test.mjs` with its tests (use the throwaway-install helper pattern of `registry.test.mjs` for end-to-end checks).
2. Add the import and the array entry in `scripts/roadctl/index.mjs`.
3. Document the command in `docs/roadctl.md`, and a line in `CHANGELOG.md`.
4. Run all suites (below). The shared file is not touched unless the module needs a seam that does not exist yet.

## Tests and installation

```sh
node --test scripts/update-installed.test.mjs
node --test scripts/roadctl.test.mjs
node --test scripts/roadctl/*.test.mjs
python3 -m unittest discover -s evals/tests -v
python3 scripts/check_links.py
```

`update-installed.mjs --roadctl --apply` installs `roadctl.mjs` and the `.mjs` files of `scripts/roadctl/` (not `*.test.mjs`) into `~/.local/share/road-map-journal/`, keeping a `.bak-<time>` of every changed file. A new file that must be installed with roadctl goes into `scripts/roadctl/`; the installer copies that folder as it is, so nothing else needs registering. Tests of the installed copy run it from a temporary directory (`update-installed.test.mjs`).
