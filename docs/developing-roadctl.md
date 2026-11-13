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
| Named hooks | `hooks: { 'claim-after'(ctx) {} }`, names in `HOOK_NAMES` of `registry.mjs` (an unknown name stops roadctl at start) | synchronous calls at fixed places, `MODULE_REG.callHook(name, ctx, io, prior)`; a hook that throws is a warning and gives no value. `tick-before` (in `tickCommand`, after the items, before the limits gate: may return `{ run: { 'project/id': { attempt } } }`, merged into the `routine` of a RUN item), `tick-ledger` (in `appendTickLedger`: `{ handled: true }` when the module wrote the ticks.jsonl line itself, else roadctl appends it), `routine-done-before` (CLI `routine done`: `{ text }` replaces the summary, `{ refuse }` refuses the run), `routine-done-after` (gets `ctx.done`, the result of `routineDone`, and `ctx.prior`, the value of the module's own before-call), `claim-after` and `report-after` (the result of `claimCard` / `reportCard` as `ctx.r`). Their callers are marked `seam` in `roadctl.mjs` |
| Helpers | `ctx.api` (`findBoard`, `loadBoard`, `knownBoards`, `hasBoardSources`, `loadRegistry`, `sanitize`, `today`, `lint`, `VERSION`; for doctor also `boardRequires`, `compareVersions`, `nowMs`, `workspaceRoots`, `userBoardsFile`, `registryPath`, `syncContext`, `syncState`, `routineRows`, `providerTable`, `splitCommand`, `hostOfAgent`, `limitsCachePath`, `tickLedgerPath`) | `moduleApi()` in roadctl.mjs; a module does not import roadctl.mjs. Adding a helper is an edit of the shared file |

Contract details:

- A command name must not exist already (built-in or another module); a header key must not be known already. A clash stops roadctl at start with a message naming the module, so it cannot silently change old behaviour.
- `run(ctx)` gets `{ flags, args, io, out, env, api, modules }` and returns the exit code (a thrown error is printed as `roadctl: ...` with exit 2, like built-in commands). Keep the effect mark (`read`, `write`, `git`) true: a test runs every help.
- The tick hook gets copies of `{ agent, decision, limits, items, sync, boardDirs }` plus `env` and `api`. It observes: it cannot change the decision, the output or the exit code, and a hook that throws only prints a warning on stderr. Since 0.3.0 its context also has `filter` (`--routine` / `--kinds`, or null) and `routines` (the rows of `routineRows` of every board, with `project`). It is not called when tick was busy or failed before deciding.
- Modules have no side effects at import. A module that fails to load stops roadctl with the error (a copy without the whole `roadctl/` folder still runs the built-in commands).
- Keep the `roadctl help` overview about one screen (a test caps it at 70 lines): use `hidden: true` for internal commands, and mind the budget before adding visible ones.
- A visible module command must appear in the overview (automatic) and in [roadctl.md](roadctl.md) (`roadctl <name>`); the test "help and docs" in `scripts/roadctl/registry.test.mjs` checks both for every module command.

## Compatibility between copies: `VERSION` and `requires`

roadctl is installed as separate copies on several machines, and boards are shared through git, so a copy can meet a board written by a newer one. A copy that does not know a new header key only prints `unknown key` (a warning), and a copy that does not know a new value of a known field may treat it as an error. Neither stops it from running a routine "as before", without seeing, say, a `HOLD` or an `allow` that a newer copy wrote. Two rules and one mechanism keep that from happening:

1. **No new values in old fields.** A field that older copies already read keeps its set of values (`last_result` stays `ok|escalated|failed`; a new detail goes into a new key and the Log). An unknown value in a known field is an error for an old copy, and an error is not a refusal the owner can read.
2. **Every card that adds a header key (card, routine or `config.json`), a command that old copies must not bypass, or a new meaning of an existing key raises `requires`** (below), in the same change.
3. **`requires` in `board/config.json`** (`"requires": "0.3.0"`): the oldest roadctl that understands the board. A copy that is older refuses the whole board: `tick` offers no item of any kind from it (no `RUN`, `TAKE`, `ACCEPT`, `START`, `STALE`) and prints one `requires:` line, `lint` reports rule 10, `routine list`/`show` say `would not run`, `brief` has a `REQUIRES` line. A board without `requires` is never refused. The value is a string like `0.3.0` (`0.3`, `v0.3.0`, `0.3.0-rc1` are read as well); a value nobody can read refuses too (fail closed). The check lives in `scripts/roadctl.mjs` (`boardRequires`), not in a module, so that a partial install cannot lose it.

**`VERSION` (in `scripts/roadctl.mjs`) is raised in the same change as any change of a format** (a new key or value, a new meaning, a changed `tick --json` field). Patch for fixes that touch no format, minor for a format change. `board_version` is a different number: it counts incompatible changes of the board layout itself and is not raised by a new optional key.

**Order of raising.** (1) Merge the change with the new `VERSION` (for example `0.3.0`); (2) install that version on every machine that runs `tick` or routines (`roadctl version` on each); (3) in the same step or later, set `"requires": "<that version>"` in the `config.json` of each board that now uses the new key, and only then write the new key into cards or routines. A copy that already supports `requires` (0.2.0 or newer) but is older than the board asks stops at once and says why. A copy older than 0.2.0 does not know `requires` at all: it ignores the key in `config.json`, only warns about an unknown header key, and runs as before. Such a copy must be updated first (`scripts/update-installed.mjs --roadctl`; `roadctl version` shows what a machine has), and only after that may a new key appear on a board it serves. The very first rollout (0.2.0, the version that introduced `requires`) therefore protects nothing by itself; it protects every later change.

**Checklist for a card that changes a format** (put it in the card's Acceptance):

- [ ] no new values in a field that older copies read (new detail: a new key, or the Log);
- [ ] `VERSION` raised, and `requires` documented for the boards that use the change (CHANGELOG says which version and what an older copy does);
- [ ] a test that an older copy (the `version` parameter of `boardRequires`, or `requires` above the real `VERSION`) offers nothing for such a board, and one that a board without `requires` is unchanged;
- [ ] if `tick --json` changes: `scripts/testkit/tick-schema.mjs` and `docs/roadctl.md` in the same change.

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
ROADCTL_PRIVATE_MARKERS=/path/to/list.txt node --test scripts/roadctl/privacy.test.mjs   # optional, local
python3 -m unittest discover -s evals/tests -v
python3 scripts/check_links.py
```

## Test kit (`scripts/testkit/`)

Shared helpers for tests. It is not installed (the installer copies only `scripts/roadctl/`), and none of its files is a `*.test.mjs`; its own tests are `scripts/roadctl/testkit.test.mjs`. A new helper or fake goes here as a new file, not into `roadctl.test.mjs`.

| File | What it gives |
| --- | --- |
| `fakes.mjs`, `fake-exec.mjs` | `installFakes(dir)` writes small executables `claude`, `codex`, `ssh`, `hermes` and `wsl.exe` into `dir` (put it first on `PATH`). Each call appends one JSON line to `$FAKE_LOG`: argv, working directory, pid, mode, the environment (`FAKE_*`, `ROADCTL_*`, `XDG_*` and the keys of `FAKE_ENV_KEYS`) and stdin; `readCalls(log, name)` reads them, `isProbe(call)` tells a limits probe from a start of work. The mode is `FAKE_<NAME>_MODE` or `FAKE_MODE`: `ok` (default; `claude -p ... stream-json` and `codex app-server` answer the limits probe, `FAKE_U5`, `FAKE_U7`, `FAKE_5H`, `FAKE_7D` set the numbers; `FAKE_AFTER` is a shell command standing for what the agent did, for example `routine done`), `hang`, `crash` (`FAKE_EXIT`, `FAKE_SIGNAL`), `silent`, `huge` (`FAKE_HUGE_BYTES`) and, for `ssh` and `wsl.exe`, `run` (run the remote command locally). The modes are the switch for the end-to-end scenarios of later cards. POSIX only: use `FAKES_SKIP` |
| `time.mjs` | `T0`, `clock(iso)` (the `ROADCTL_NOW` environment), `shift(minutes, iso)`, `ms(iso)`; and the real-time helpers `sleepSync`, `waitFor`, `wallClock` |
| `tick-schema.mjs` | `tickJsonProblems(json)`: the contract of `roadctl tick --json` (strict: an unknown key is a problem). A change of that JSON changes this file and `docs/roadctl.md` in the same commit |
| `doctor-schema.mjs` | `doctorJsonProblems(json)`: the same for `roadctl doctor --json` (also: a failure needs a hint, the summary must match the checks) |
| `helpdocs.mjs` | `helpDocsProblems(table, { overview, docs })`: every visible command in `roadctl help` and in `docs/roadctl.md`, every flag in `docs/roadctl.md`; a test feeds it an invented table to prove that it fails |
| `privacy.mjs` | the private-marker scan (below) |

**Time.** roadctl takes "now" from `ROADCTL_NOW` (an ISO-8601 UTC time) when it is set. A test passes the time from `time.mjs` and never reads the clock of the machine; a test in `scripts/` that calls the ambient clock fails `testkit.test.mjs`. Existing fixed ISO literals in old tests are deterministic and stay as they are. **Process liveness is the exception and uses real time**: the tick lock is aged by the file's modification time and a stale lock is judged by the real clock, a hanging child has to be killed in real seconds, and a background job started by an example needs a moment to appear. Such a test uses `wallClock`, `sleepSync` or `waitFor` from `time.mjs`, so the use of real time is visible at the call.

**Private markers.** The repository is public. To check that no private name, host, path or token has crept into a tracked file, keep a list of markers outside the repository (one per line, matched as text ignoring case, `#` comments) and run `ROADCTL_PRIVATE_MARKERS=/path/to/list.txt node --test scripts/roadctl/privacy.test.mjs`. Without the variable (CI, other clones) that test is skipped, not failed; a list inside the repository is refused. The scan covers the tracked files and their names, skips binary files, and reports `file:line (marker #N)` without printing the marker. Run it before committing fixtures made from real runs. The tests of the scanner use synthetic markers only; never put real ones in a test, a doc or a commit.

`update-installed.mjs --roadctl --apply` installs `roadctl.mjs` and the `.mjs` files of `scripts/roadctl/` (not `*.test.mjs`) into `~/.local/share/road-map-journal/`, keeping a `.bak-<time>` of every changed file. A new file that must be installed with roadctl goes into `scripts/roadctl/`; the installer copies that folder as it is, so nothing else needs registering. Tests of the installed copy run it from a temporary directory (`update-installed.test.mjs`).
