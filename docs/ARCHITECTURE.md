# Architecture

Octax Solobill is deliberately small: one Node process, one SQLite file, and object storage for
files. This page covers how it fits together and the rules every change must keep.

## Layout

| Path | What lives there |
|---|---|
| `src/server` | Hono API, services, PDF engine, scheduled jobs and scripts |
| `src/server/db` | Drizzle schema. Migrations are in `drizzle/` |
| `src/server/pdf` | PDF rendering, Arabic shaping and bundled fonts |
| `src/server/test` | Vitest suites, including the API contract and workspace isolation tests |
| `src/shared` | Types and helpers used by both server and client: money, API responses |
| `src/client` | React admin app |
| `openapi.json` | Generated API description. Regenerate with `pnpm openapi` |

## Stack

| Area | Choice |
|---|---|
| Language | TypeScript on Node 26, with pnpm |
| API | Hono, with Zod validation |
| Database | SQLite through Drizzle ORM and better-sqlite3 |
| Admin UI | React 19, Vite, TanStack Query and stock shadcn/ui components |
| File storage | Cloudflare R2 (or any S3 API), with local disk when it is not configured |
| PDF writing | `@cantoo/pdf-lib`, `fontkit`, `bidi-js` |
| PDF viewing | `pdfjs-dist`, in the template mapping editor |
| Scheduled jobs | `croner`, inside the server process |
| Tests and lint | Vitest and Biome |

Use `@cantoo/pdf-lib` with `fontkit`. Do not switch to the original `pdf-lib` or
`@pdf-lib/fontkit`: the PDF engine and its Arabic shaping are built and tested against this pair.

Do not add Redis, a separate queue, a headless browser or a second database. The app is meant to
stay small enough to run as one container.

## How a request flows

1. The browser or the iOS app calls `/api/v1/...`. The web app uses a session cookie. The apps use a
   bearer token from `POST /api/v1/auth/token`.
2. Auth middleware resolves the user and their workspace. Every service function takes that
   workspace first.
3. Services read and write SQLite through Drizzle. Files go through `storage.ts`, which writes to R2
   or to `DATA_DIR/files`.
4. Issuing an invoice renders its PDF once, stores it, and freezes the customer-visible fields.

Scheduled jobs run in the same process: renewal drafts and reminders every day at 05:00 UTC, and a
database backup at 02:30 UTC.

## Domain rules that must always hold

The numbers are referenced from code comments, so keep them stable.

1. **Customer documents never expose internal data.** Cost, profit, original invoices and provider
   details stay out of customer PDFs and customer-document payloads.
2. **Customer documents are issued by the owner's company.** A template carries the owner's own
   company details and tax number. Provider names and logos are internal labels and are never
   printed.
3. **Issued documents are immutable.** Customer-visible fields and the stored PDF do not change after
   issue, except that a discount rebuilds the PDF. Correct them by voiding and reissuing, or, when no
   payment is recorded, by reversing to draft, which deletes the stored PDF. Internal cost fields
   stay editable.
4. **Proformas never count as revenue, cost or receivables.**
5. **Profit excludes tax.**
6. **Money is never a float.** Use the helpers in `src/shared/money.ts`. Amounts are integers scaled
   by 10,000, and exchange rates are integers scaled by 100,000,000.
7. **Currencies have different decimal places.** Round using the currency's own decimals, for
   example 3 for OMR, KWD and BHD.
8. **Stored files are reached only through authenticated routes.** A bucket may have a public
   domain, so never build, return or log a public URL for a stored file, and keep object names
   random.
9. **One issuing company has one number series.** Numbers are per company, not per template, because
   one company uses several layouts. A template with no company details has its own series. The
   owner can type a number instead, and only a typed number can reuse one from a voided document.
10. **The `web` service runs one container.** SQLite has one writer, and the numbering lock and the
    sign-in rate limits live inside the process. They are shared by all workspaces.
11. **Payments stay off customer documents.** They never enter the render payload, and paying an
    invoice never changes its PDF. A discount prints in the totals, before tax.
12. **Every domain query is scoped to the caller's workspace.** Services take `ws` first. Every
    `where` on a domain table includes `workspace_id`, and every insert sets it. A lookup by id
    outside the workspace is a 404. IDs in request bodies are checked against the workspace before
    use. Jobs run per workspace. A new table gets `workspace_id` unless the schema guard test lists
    it as global.
