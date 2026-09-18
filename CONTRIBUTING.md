# Contributing a Tool

Firedrill-compatible Tools can live in any repository and under any npm scope. Contribute here when
you want a Tool to become part of the maintained community collection.

Before opening a pull request:

1. Keep the package self-contained under `packages/<tool-id>/`.
2. Declare only behavior the package actually implements.
3. Compute responses from Tool state rather than returning canned fixtures.
4. Include deterministic starter data and a conformance suite.
5. Document supported protocols, operations, faults, and known limits.
6. Run `pnpm install --frozen-lockfile` and `pnpm check` from the repository root.

Package and Tool versions must match. Once a `package@version` release identity is recorded, its
bytes are immutable; change both versions before updating `release-identities.json` with
`pnpm release:identities:update`.

## npm scope migration bootstrap

The root workspace temporarily maps the two `@firedrill-run` development dependencies to their
API-equivalent pre-migration `@firedrill-tools` releases. This keeps a clean checkout and CI fully
verifiable while the new core scope is being published; it does not alter the dependency names in
any Tool package or its release archive. Remove the two root `pnpm.overrides` entries immediately
after `@firedrill-run/cli@0.1.0-rc.1` and `@firedrill-run/tool-sdk@0.1.0-rc.1` are public, regenerate
the lockfile, and rerun the complete gate.

Contributions are licensed under Apache-2.0.
