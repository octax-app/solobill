# Contributing

Thanks for helping. Octax Solobill is meant to stay small: one Node process, one SQLite file, and
no extra services. Changes that keep it that way are the easiest to accept.

## Before you start

- For anything bigger than a fix, open an issue first, so we can agree on the approach before you
  write code.
- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Its domain rules are not negotiable: customer
  documents never show cost or profit, issued invoices are immutable, money is never a float, and
  every query is scoped to the caller's workspace.

## Setup

See [Development](README.md#development) in the README.

## Pull requests

- Add or update tests for what you change. New API routes need a response type in
  `src/shared/api-responses.ts` and a regenerated `openapi.json` (`pnpm openapi`).
- A new database table needs a `workspace_id` column. The schema guard test fails without it.
- Schema changes need a migration from `pnpm db:generate`. Never edit an existing migration.
- Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before pushing. CI runs the same checks.
- For PDF changes, render the result and look at it, including with Arabic text. A passing test does
  not prove the layout or the shaping is right.
- Keep the UI on stock shadcn/ui components. They go in `src/client/components/ui`. Tailwind v4
  writes CSS variables in classes as `w-(--name)`, not `w-[--name]`.
- Don't add Redis, a queue, a headless browser or a second database.

## The iOS app

The iOS app lives in [octax-app/solobill-ios](https://github.com/octax-app/solobill-ios). Its
decoding tests use real responses from this server. After changing a response the app reads, clone
the iOS repo next to this one and run:

```sh
pnpm ios:fixtures
```

Set `IOS_FIXTURES_DIR` if your iOS clone's fixtures folder is somewhere else.
