# Aliquot docs

Start with the [README](../README.md): what Aliquot does, the quickstart and the demo.

| If you are | Read |
|---|---|
| Trying it on a laptop | [Quickstart](../README.md#quickstart), then `pnpm doctor` if a step fails |
| Setting it up for a lab | [The studio](../README.md#the-studio), [`lab.example.toml`](../lab.example.toml) (every table, commented) and [Model providers](../README.md#model-providers) |
| Research IT, a data steward or an IRB | [For research IT and the IRB](for-research-it-and-irb.md): where each data class may go, what runs where, what is stored and under which key, and what is not covered yet |
| Changing the code | [`AGENTS.md`](../AGENTS.md) (setup and checks, for people and coding agents) and [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Reviewing the design | [`design/DESIGN.md`](design/DESIGN.md), then what each release added: [`DESIGN-v02.md`](design/DESIGN-v02.md) and [`DESIGN-v03.md`](design/DESIGN-v03.md). [`SLICE.md`](design/SLICE.md) is the first vertical slice and [`STACK.md`](design/STACK.md) the stack decisions |
| Recording the demo | [`demo-recording.md`](demo-recording.md) |

What changed in each release is in [`CHANGELOG.md`](../CHANGELOG.md).

## The terminal tools

| Command | What it does |
|---|---|
| `pnpm doctor` | Checks this machine and prints the fix for each problem. Changes nothing. |
| `pnpm demo` | Runs the synthetic lab0 lab: Postgres, a published handbook, the worker and the web door. `--studio` adds the studio. |
| `pnpm demo:agent --backend claude-code` | The same lab on a real Claude Code or Codex login, for a developer's machine. `--research` adds a data and literature question. |
| `pnpm aliquot runs` | Lists the newest runs: start time, agent version, outcome, event count, chain check. |
| `pnpm aliquot record <run-id>` | Prints one run's record and checks its hash chain. Exit 3 means the chain is broken. |
| `node … packages/core/bin/kb.ts` | The steward's knowledge base tool: `compile`, `coverage`, `diff`, `search`, `publish`. See [The studio](../README.md#the-studio). |
| `pnpm typecheck`, `pnpm test`, `pnpm lab0` | The checks every change must pass. CI also runs `pnpm slice1` and `pnpm unit3`. |

`aliquot` and `kb` take `--config lab.toml` and read the database from the env var `lab.toml` names (`DATABASE_URL` by default).
