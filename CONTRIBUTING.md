# Contributing

Thank you for helping. Aliquot is early and has been tested on a synthetic lab only. Reports from labs that try it
are the most useful contribution.

## Before you change code

1. Follow the setup in [`AGENTS.md`](AGENTS.md). It applies to people as well as coding agents.
2. Run `pnpm doctor`, then `pnpm typecheck`, `pnpm test` and `pnpm lab0`. Each must pass before you start.
3. Read the section of [`docs/design/DESIGN.md`](docs/design/DESIGN.md) for the module you are changing.

## Rules the checks enforce

- `decideEgress` in `packages/core/src/dataclass.ts` is the only egress decision.
- Only the files listed in `scripts/boundaries.ts` may import a network module.
- Data classes only go up.
- A field the run loop reads belongs in `ResolvedAgent`, so it is part of the version hash.
- The pre-registered fixtures in `fixtures/lab0/` are fixed.

A change that needs one of these rules relaxed needs a design note first. Open an issue that explains why.

## Adding a tool

Aliquot has no contributed tools yet. A new tool is a change to core: a `defineTool` in `packages/core/src/tools.ts` or `literature.ts`, added
to `builtinTools()`, with a test. It declares the class of what it reads, its effects, and every host it may reach.
It reaches the network only through `ctx.fetch`. Tools a lab adds without changing core are planned.

## Pull requests

- Keep one change per pull request, with a test that would fail without it.
- Write commit messages that say what changed and why.
- Run the checks that `AGENTS.md` lists for the area you touched.

## Labs

If your lab wants to try Aliquot, open a **Pilot interest** issue. Tell us what your lab studies, which data classes
you handle and where your lab's agents would run. You do not need to share any data.
