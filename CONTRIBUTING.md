# Contributing

Thank you for helping improve Road-map Journal. The public repository is offered under the [MIT License](LICENSE). Submit only material you have the right to contribute under those terms.

- Explain the scenario and expected agent behavior before proposing a change.
- Keep the core portable across agent hosts and respect existing project conventions.
- Add or update an evaluation scenario for a meaningful behavior change; distinguish a proposed check from one actually run.
- Share only synthetic, sanitized examples; do not submit private plans, secrets, credentials or transcripts.
- Do not copy substantial third-party material without confirming compatible licensing and retaining required attribution.
- Changing `scripts/roadctl.mjs` or adding to it: read [docs/developing-roadctl.md](docs/developing-roadctl.md) first (new parts go into modules with their own tests; the shared file is edited by one person at a time).
- Describe what was tested, with agent and model versions where relevant, and what remains unverified.

Open an issue to discuss larger changes before investing in them. Maintainers may request a minimal reproducible scenario.
