# Security

Aliquot exists to keep restricted research data on lab hardware, so a leak is the most serious bug it can have.

## Report a problem

Use GitHub's private vulnerability reporting: the **Security** tab of this repository, then **Report a vulnerability**.
Do not open a public issue for a leak.

Examples of what to report:

- any route by which content of a class reaches a destination above its ceiling;
- a model, tool or agent CLI that can reach the network or the filesystem around the seal;
- a forged class label that a consumer accepts;
- a break in the hash chain that verification does not catch.

Please include the commit, `lab.toml` with secrets removed, and the steps or the test that shows it.

## What is in scope

The code in this repository: `packages/core`, `packages/studio`, the scripts and the built-in tools in
`packages/core/src/tools.ts`. The documented limits in
the README and in `docs/for-research-it-and-irb.md` (pattern-based detection, no sign-on yet, no key rotation yet) are
known, and a report that one of them exists is not a vulnerability. A way around one of the enforced rules is.

## Supported versions

Only the latest commit on `main` gets fixes while Aliquot is pre-1.0.
