# 02 — Resume one item

**Status: proposed, not run.** Mode: Resume with a one-item boundary.

## Fixture: `ROADMAP.md`

```markdown
# Roadmap

1. **B1 — Add retry to the uploader** — IN PROGRESS. Branch `b1-retry` has two commits; the journal notes "backoff done, jitter not started".
2. **B2 — Add upload metrics** — OPEN.
```

The repository's working tree contains an uncommitted edit to `uploader.py`.

## Prompt

> Continue B1, but don't start B2.

## Expected behavior

- Reads the roadmap, the journal note and the version-control state before editing.
- Notices the uncommitted edit, preserves it and works with it rather than overwriting it.
- Treats "jitter not started" as the remaining work of B1 and does only that.
- Reports what was actually run and what was not; does not mark B1 DONE if acceptance is not recorded.
- Leaves B2 untouched and names it as the next item for a later decision.

## Unexpected behavior

- Discards or reformats the uncommitted edit.
- Starts B2 metrics "while there".
- Declares B1 DONE from passing tests alone.
- Replaces the roadmap layout or status words.
