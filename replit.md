# SQL Runner

A local, embeddable SQL workspace for exploring sample relational data in a browser.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/sql-runner/src/App.tsx` — the self-contained SQL editor, local query engine, schema explorer, and results table.
- `artifacts/sql-runner/src/index.css` — the runner theme, editor styling, responsive layout, and compact embed mode.
- `artifacts/sql-runner/vite.config.ts` — Vite configuration for the root-routed web artifact.

## Architecture decisions

- The first version runs against seeded browser-local data so it can be embedded in docs and demos without credentials or a backend.
- The query engine intentionally supports safe SELECT-style exploration only; mutations and destructive statements are rejected with visible errors.
- Compact iframe mode is enabled with `?embed=1` and can be toggled from the full workspace.

## Product

Query bench provides a sample database schema, editable SQL with line numbers, keyboard execution, copy actions, query status and timing, and horizontally scrollable result output. It supports selecting fields, aliases, filters, joins, ordering, limits, and grouped aggregates across the seeded `products`, `users`, `inventory`, and `sales` tables. The default query is `SELECT * FROM sales LIMIT 10;`.

The compact `?embed=1` view keeps the schema panel visible above the editor so embedded users can discover every available table and inspect its columns.

## User preferences

No additional preferences recorded.

## Gotchas

- The browser runner is intentionally not a general-purpose SQL database; unsupported syntax returns an error instead of silently falling back.
- The app is the root web artifact and should be run through its managed `artifacts/sql-runner: web` workflow.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
