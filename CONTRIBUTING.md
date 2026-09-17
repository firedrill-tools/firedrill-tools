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

Contributions are licensed under Apache-2.0.
