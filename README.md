# Firedrill Tools

Stateful synthetic services for testing AI agents with [Firedrill](https://firedrill.run).

Each package gives an agent a safe version of a real service to work against. Tool calls read and
write persistent synthetic state, faults can be reproduced, and browser-enabled Tools expose a UI
over the same records as their API and MCP operations.

## Use a Tool

Install the Firedrill CLI and a Tool package in your agent project:

```sh
npm install --save-dev @firedrill-tools/cli@next @firedrill-tools/tool-gmail
npx firedrill tool add @firedrill-tools/tool-gmail --install
npx firedrill serve
```

`firedrill serve` starts the selected Tools locally and prints the HTTP, MCP, CLI, and browser-app
connections they provide. Point your agent's existing connection seam at those local endpoints; the
agent does not need Firedrill-specific business logic.

Run the Tool's conformance suite before using it in a drill:

```sh
npx firedrill tool test gmail
```

## Available Tools

Packages live under [`packages/`](./packages). The collection includes communication, CRM, payments,
documents, storage, developer, observability, and back-office services. Every package README lists
its supported operations, protocols, starter state, scenarios, faults, and known limits.

Use the CLI catalog to browse and install packages:

```sh
npx firedrill tool list
npx firedrill tool search calendar
npx firedrill tool inspect gmail
```

## Package contract

A Tool package is ordinary source code plus a portable Firedrill definition. It owns:

- operation declarations and executable behavior;
- state schema and deterministic starter data;
- protocol mappings such as HTTP, MCP, CLI, callbacks, and an optional browser app;
- scenarios and fault behavior;
- a conformance suite that proves supported operations and deterministic reset.

Packages are independent. You can install these Tools, keep a private Tool in your own repository,
or publish any compatible package under your own npm scope.

## Develop a Tool

Start with the public authoring guide in the
[Firedrill repository](https://github.com/firedrill-tools/firedrill/blob/main/docs/TOOL_AUTHORING_GUIDE.md),
then use an existing package here as a working reference.

```sh
npx firedrill tool create my-service --template stateful --package \
  --name @your-scope/firedrill-tool-my-service --root ./packages/my-service
npx firedrill tool validate my-service --root ./packages/my-service
npx firedrill tool test my-service --root ./packages/my-service
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) when you want to contribute a package to this collection.

## License

Apache-2.0. Product names and logos belong to their respective owners and are used only to identify
the service simulated by a Tool; no affiliation or endorsement is implied.
