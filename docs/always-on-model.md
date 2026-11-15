# The always-on model of road-map-journal

How unattended work in road-map-journal maps onto the model in Anthropic's article [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents) (2026-11-13), what we adopt, and what we deliberately do differently. Written 2026-11-15 after a comparison and an independent review; the changes it led to are the 2026-11-15 planning revision in [ROADMAP.md](../ROADMAP.md). Russian version: [always-on-model.ru.md](always-on-model.ru.md).

This is a map, not a promise: every line says whether it is **implemented** or **planned** (with the ROADMAP item). Planned items are not authorization to build or run anything.

## The cycle

An "always-on" agent is not running all the time. It sleeps, wakes on something, does one short **run**, writes what happened back, and sleeps again. Sleeping costs no model tokens.

In road-map-journal:

- **Wake:** a system timer or scheduler runs `roadctl tick` (implemented), later the conductor `roadctl serve --once` (planned, P5.25), which the bridge may also start right after recording an owner answer or request (planned, P5.25).
- **Decide without a model:** `tick` reads the boards, finds work and checks the subscription limits and the owner's reserve; a model starts only when there is work and the reserve allows it (implemented). This step has no equivalent in the article.
- **Run:** one bounded model run under `roadctl supervise`: one run per key, a timeout, an orphan check, an outcome recorded even when the agent reports nothing (implemented, P5.2).
- **Write back:** card Log, Handoff and Evidence in git; `routine done` / `report` with summary fields; the local run ledger (implemented).

## The five primitives

| Primitive | Article | road-map-journal | State |
| --- | --- | --- | --- |
| **Inbox** | a durable event list, a fast handler, one worker | work is derived from the git board at read time (`TAKE`, `ACCEPT`, `START`, `STALE`, `RUN`); owner answers and requests land on the board (P5.24, P5.36); channel writes are idempotent on the channel's id (P5.24, P5.36) | derivation implemented; answers and idempotency planned |
| **One worker** | one active worker per inbox | per-agent `tick` lock; `supervise` lock per routine, card or orchestrator, with heartbeat, orphan detection and back-off; conductor runs actions one at a time (P5.25) | implemented; conductor planned |
| **Timers** | follow-up timers and schedules, polled by a scheduler | routine `every` and `hours`, lease expiry (`STALE`), run deadlines; computed at read time, no timer store; a one-shot re-check date is an idea (P5.37) | implemented; P5.37 idea |
| **Memory** | instructions, user notes, what was told, task progress; optional curation | instructions: mandate (P5.33), routine file bound to its approval hash (P5.15), managed instruction blocks; progress: card Handoff, checkpoints, Log in git; what was told: `digest.state.json` (keys and times, never text); owner preferences and curation are an idea (P5.38) | partly implemented; mandate planned; P5.38 idea |
| **Permissions** | credential proxy, auto-mode classifiers, deferred tool calls | owner-only commands, scopes `read+board` / `external`, approval by content hash, autonomy levels L1–L4 (P5.33), unattended mode (P5.3); questions block only the card while other work continues (P5.24); credentials rule below (P5.19, P5.7) | partly implemented; rest planned |
| **Outbox** | a send tool, or a table plus dispatcher with error recovery; start quiet | `roadctl digest`: problems only by default, each problem key once, at most six lines per run, a daily overview with OVERDUE and liveness (implemented); confirmed two-phase delivery (`digest --json` with a batch token, then `digest --ack`) for the bridge (planned, P5.26) | implemented; confirmed delivery planned |

## Rules we keep that the article does not have

- **An unknown outcome is never retried automatically** (P5.2, P5.4). The article retries an event whose worker died; that is safe only for idempotent work.
- **Limits and the owner's reserve** gate every model start (P4.3).
- **Liveness:** the daily overview is the only way to tell "all is well" from "the scheduler is dead" (P5.13, P5.30).
- **Evidence over claims:** a report is data; acceptance needs evidence and, on L3+, a reviewer on a different model (P5.35).
- **Provider neutrality and a git board as the contract** across several machines.

## Deliberately not adopted

- **Permission classifiers (auto mode).** Permission decisions stay deterministic rules and owner decisions (P5.3, P5.32).
- **Folding an event into a live run or interrupting it.** An event waits for the next run; `pause --now` is the only interruption (P5.24).
- **Automatic replay of an event whose run crashed.** See above.
- **A scheduler that copies due timers into an inbox store.** `tick` computes "due" at read time; there is no second store to reconcile.
- **Session resume as the continuation contract.** The checkpoint and Handoff are the contract; `session_id` is kept for diagnostics only.
- **Memory written by agents without the owner's approval, and storing sent message text.**

## Credentials

- Never in git, the board, a prompt, a routine file, the registry, the run ledger, run logs or the digest.
- Read-only, least-privilege credentials may live on the machine that runs a routine (today's `read+board` routines need them).
- Write-capable credentials stay outside the agent's environment; this is a precondition for any `external` scope (P5.19). A host connector, a credential-injecting proxy or an agent on the environment's side are examples; none is built here.
- The launch description prints variable names, never values (P5.7).

## Memory hygiene

Store only what cannot be looked up again; point to cards, commits and issues instead of copying them. Keep the per-run overhead (prompt, tool list, files read at start) small: `tick --prompt` names files by path and never inlines routine text.
