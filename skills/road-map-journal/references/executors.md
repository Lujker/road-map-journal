# Executors and the registry

Read this when the owner asks to list, review or change the agents and executors that may take delegated work, for example «давай составим список агентов и исполнителей», "set up the executor registry", "who can take tasks?".

The registry is a short, machine-readable list for delegation and limits. The helper looks for it in this order and uses the first that exists: the file named by `ROADCTL_REGISTRY`, `<workspace>/agents/registry.json`, `${XDG_CONFIG_HOME:-~/.config}/road-map-journal/registry.json` (the last is where a user without a central workspace keeps it). Format: the helper's documentation and its example file. It is a projection, not a second description: where the owner already describes agents and environments in prose (agent cards, workspace notes), each entry links to that description (`card`) instead of copying it.

## Build or review it with the owner

1. **Discover.** Read existing descriptions of agents and environments, and the current registry if there is one. Note which entries are historical, planned or unverified; a description is not proof that an agent is available.
2. **Propose a draft.** Only agents that can take work now. For each: name `host@machine`, host (`claude-code`, `codex`, `hermes`, `script`), machine, roles (`orchestrator`, `worker`, `reviewer`), `can_accept`, provider or subscription account (for limits), the projects it may work on (only if the owner wants such a limit), how it is started (a note; the helper never runs it), and `card`. Show uncertain fields as questions, not guesses.
3. **Ask** what you cannot find out yourself; every owner's setup differs (machines, accounts per machine, which agent may reach which machine), so never carry one owner's setup over to another. Ask, for example: which agents are active, whether some agents should keep to certain projects (many owners need no such limit), whether two agents share one subscription, who may accept results. Give a recommendation for each open choice.
4. **Write only with consent.** Keep the owner's language for notes. Mark unverified access as such. Do not record credentials or secrets.
5. **Check.** Validate the JSON, then use the helper where available (`roadctl tasks --for <agent>`, `roadctl limits --check <agent>`) and report what was checked and what remains unverified, for example that an agent was never started through the recorded command.

The `orchestrator` role matters for unattended work: a board that has the owner's autonomous queue switched on offers its cards only to orchestrators (and, if the board lists agents, only to those). Whether a board does is the owner's decision, see [Autonomous or personal work](autonomy.md); do not add `orchestrator` to an agent just to make something start.

Changes later follow the same steps: a new machine, a retired agent or a new provider is an edit the owner agrees to, recorded with the date.
