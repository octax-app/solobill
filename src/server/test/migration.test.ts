import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { is } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../db/schema.ts'

/**
 * Plan 22's migration (0007) moves existing data into workspace 1. This builds a database at
 * the last migration before it, fills every table, migrates it, and checks nothing was lost.
 * It uses its own SQLite files, not the app's `db`, which opens `config.databasePath`.
 */

const MIGRATIONS = path.resolve(import.meta.dirname, '../../../drizzle')
/** The last migration before plan 22. */
const PRE_WORKSPACES = '0006_eminent_morlun'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solobill-migration-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** A copy of `drizzle/` that stops at `PRE_WORKSPACES`. */
function preWorkspaceMigrations() {
  const folder = path.join(tmp, 'pre-workspaces')
  fs.cpSync(MIGRATIONS, folder, { recursive: true })
  const journalFile = path.join(folder, 'meta/_journal.json')
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
  const last = journal.entries.findIndex((e: { tag: string }) => e.tag === PRE_WORKSPACES)
  expect(last, `${PRE_WORKSPACES} is not in the journal`).toBeGreaterThan(-1)
  for (const entry of journal.entries.slice(last + 1)) {
    fs.rmSync(path.join(folder, `${entry.tag}.sql`))
  }
  journal.entries = journal.entries.slice(0, last + 1)
  fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2))
  return folder
}

/** Same as `runMigrations`: foreign keys are off while tables are rebuilt. */
function migrateTo(sqlite: Database.Database, folder: string) {
  sqlite.pragma('foreign_keys = OFF')
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder })
  } finally {
    sqlite.pragma('foreign_keys = ON')
  }
}

function openDatabase(name: string) {
  const sqlite = new Database(path.join(tmp, name))
  sqlite.pragma('foreign_keys = ON')
  return sqlite
}

const T = '2026-10-01T08:00:00.000Z'
const DEVICE = 'ab'.repeat(32)
const seller = JSON.stringify({
  companyName: 'MG Trading',
  companyAddress: 'Muscat',
  taxNumber: 'OM1100',
  bankDetails: 'IBAN OM00',
})

/** One or more rows in every table that existed before plan 22. */
const FIXTURE = `
INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES
  (1, 'owner@example.com', 'hash-1', '${T}', '${T}'),
  (2, 'second@example.com', 'hash-2', '${T}', '${T}');
INSERT INTO auth_sessions (id, token_hash, user_id, expires_at, created_at, updated_at) VALUES
  (1, 'session-hash', 1, '2026-12-01T00:00:00.000Z', '${T}', '${T}');
INSERT INTO api_tokens (id, token_hash, user_id, name, last_used_at, created_at, updated_at) VALUES
  (1, 'token-hash', 1, 'Phone', '${T}', '${T}', '${T}');
INSERT INTO device_tokens (id, api_token_id, token, environment, created_at, updated_at) VALUES
  (1, 1, '${DEVICE}', 'sandbox', '${T}', '${T}');
INSERT INTO settings (id, base_currency, renewal_lead_days, invoice_prefix, proforma_prefix, created_at, updated_at) VALUES
  (1, 'USD', 10, 'INV-', 'PF-', '${T}', '${T}');
INSERT INTO fonts (id, name, regular_file, bold_file, covers_arabic, created_at, updated_at) VALUES
  (1, 'Plex', 'fonts/00000000-0000-4000-8000-000000000001.woff', 'fonts/00000000-0000-4000-8000-000000000002.woff', 1, '${T}', '${T}');
INSERT INTO templates (id, name, kind, is_default, pdf_file, company_name, company_address, tax_number, bank_details, font_id, separators, custom_fields, created_at, updated_at) VALUES
  (1, 'System template', 'system', 1, 'templates/00000000-0000-4000-8000-000000000003.pdf', 'MG Trading', 'Muscat', 'OM1100', 'IBAN OM00', 1, '[]', '[]', '${T}', '${T}'),
  (2, 'Cloud', 'uploaded', 0, 'templates/00000000-0000-4000-8000-000000000004.pdf', 'MG Trading', '', 'OM1100', '', NULL, '[]', '[]', '${T}', '${T}');
INSERT INTO template_regions (id, template_id, key, page, x, y, width, height, font_id) VALUES
  (1, 1, 'line_table', 0, 40, 300, 500, 300, 1),
  (2, 1, 'customer', 0, 40, 120, 250, 80, NULL),
  (3, 2, 'line_table', 0, 40, 300, 500, 300, NULL);
INSERT INTO providers (id, name, logo_file, website, default_template_id, created_at, updated_at) VALUES
  (1, 'Contabo', 'logos/00000000-0000-4000-8000-000000000005.png', 'https://contabo.com', 2, '${T}', '${T}'),
  (2, 'Cloudflare', NULL, '', NULL, '${T}', '${T}');
INSERT INTO services (id, provider_id, name, pricing, cycle, default_cost, default_price, currency, default_template_id, created_at, updated_at) VALUES
  (1, 1, 'Dedicated server', 'fixed', 'monthly', 600000, 1000000, 'USD', 2, '${T}', '${T}'),
  (2, 2, 'R2', 'metered', 'monthly', 0, 0, 'USD', NULL, '${T}', '${T}');
INSERT INTO customers (id, name, company, currency, created_at, updated_at) VALUES
  (1, 'Acme', 'Acme LLC', 'USD', '${T}', '${T}'),
  (2, 'Globex', '', 'OMR', '${T}', '${T}');
INSERT INTO subscriptions (id, customer_id, service_id, label, cycle, started_on, next_renewal_on, cost_amount, cost_currency, price_amount, price_currency, created_at, updated_at) VALUES
  (1, 1, 1, 'Main', 'monthly', '2026-01-01', '2026-11-01', 600000, 'USD', 1000000, 'USD', '${T}', '${T}');
INSERT INTO subscription_lines (id, subscription_id, position, description, cost_amount, price_amount) VALUES
  (1, 1, 0, 'Server', 400000, 700000),
  (2, 1, 1, 'Backup', 200000, 300000);
INSERT INTO original_invoices (id, provider_id, service_id, number, issued_on, due_on, currency, fx_rate, subtotal, tax, total, base_subtotal, base_total, pdf_file, created_at, updated_at) VALUES
  (1, 1, 1, 'CTB-1', '2026-10-01', '2026-10-15', 'EUR', 120000000, 500000, 20000, 520000, 600000, 624000, 'originals/00000000-0000-4000-8000-000000000006.pdf', '${T}', '${T}');
INSERT INTO original_invoice_lines (id, original_invoice_id, description, quantity, unit_price, total) VALUES
  (1, 1, 'Server', 10000, 500000, 500000);
INSERT INTO invoices (id, type, status, source, number, issuer_key, customer_id, provider_id, service_id, template_id, issued_on, due_on, currency, fx_rate, subtotal, total, base_subtotal, base_total, seller_snapshot, paid_amount, discount_amount, revenue_adjust_base, pdf_file, paid_on, created_at, updated_at) VALUES
  (1, 'invoice', 'issued', 'manual', 'INV-0001', 'tax:OM1100', 1, 1, 1, 1, '2026-10-01', '2026-10-31', 'USD', 100000000, 1000000, 1000000, 1000000, 1000000, '${seller}', 400000, 0, 0, 'invoices/00000000-0000-4000-8000-000000000007.pdf', NULL, '${T}', '${T}'),
  (2, 'invoice', 'paid', 'manual', 'INV-0002', 'tax:OM1100', 1, NULL, NULL, 1, '2026-10-02', '2026-10-31', 'USD', 100000000, 500000, 500000, 500000, 500000, '${seller}', 450000, 50000, -50000, 'invoices/00000000-0000-4000-8000-000000000008.pdf', '2026-10-05', '${T}', '${T}'),
  (3, 'invoice', 'void', 'manual', 'INV-0001', 'tax:OM1100', 2, NULL, NULL, 1, '2026-09-01', NULL, 'OMR', 260000000, 100000, 100000, 260000, 260000, '${seller}', 0, 0, 0, 'invoices/00000000-0000-4000-8000-000000000009.pdf', NULL, '${T}', '${T}'),
  (4, 'proforma', 'issued', 'manual', 'PF-0001', 'tax:OM1100', 2, NULL, NULL, 2, '2026-10-03', NULL, 'OMR', 260000000, 200000, 200000, 520000, 520000, '${seller}', 0, 0, 0, 'invoices/00000000-0000-4000-8000-000000000010.pdf', NULL, '${T}', '${T}'),
  (5, 'invoice', 'draft', 'renewal', NULL, NULL, 1, 1, 1, 1, NULL, NULL, 'USD', 100000000, 1000000, 1000000, 1000000, 1000000, NULL, 0, 0, 0, NULL, NULL, '${T}', '${T}');
INSERT INTO invoice_lines (id, invoice_id, position, subscription_id, subscription_line_id, period_start, description, quantity, unit_price, net, total, cost_amount, cost_currency, cost_fx_rate, cost_base, original_invoice_line_id) VALUES
  (1, 1, 0, NULL, NULL, NULL, 'Server', 10000, 1000000, 1000000, 1000000, 500000, 'EUR', 120000000, 600000, 1),
  (2, 2, 0, NULL, NULL, NULL, 'Setup', 10000, 500000, 500000, 500000, 0, 'USD', 100000000, 0, NULL),
  (3, 3, 0, NULL, NULL, NULL, 'Old', 10000, 100000, 100000, 100000, 0, 'OMR', 260000000, 0, NULL),
  (4, 4, 0, NULL, NULL, NULL, 'Quote', 20000, 100000, 200000, 200000, 0, 'OMR', 260000000, 0, NULL),
  (5, 5, 0, 1, 1, '2026-11-01', 'Server from 2026-11-01', 10000, 700000, 700000, 700000, 400000, 'USD', 100000000, 400000, NULL),
  (6, 5, 1, 1, 2, '2026-11-01', 'Backup from 2026-11-01', 10000, 300000, 300000, 300000, 200000, 'USD', 100000000, 200000, NULL);
INSERT INTO invoice_payments (id, invoice_id, kind, amount, paid_on, note, group_id, created_at, updated_at) VALUES
  (1, 1, 'payment', 400000, '2026-10-05', 'Bank', 'group-1', '${T}', '${T}'),
  (2, 2, 'payment', 450000, '2026-10-05', 'Bank', 'group-1', '${T}', '${T}'),
  (3, 2, 'discount', 50000, '2026-10-05', '', NULL, '${T}', '${T}');
INSERT INTO number_sequences (id, issuer_key, type, next_value) VALUES
  (1, 'tax:OM1100', 'invoice', 3),
  (2, 'tax:OM1100', 'proforma', 2);
INSERT INTO reminders (id, kind, ref_id, message, link, read_at, pushed_at, created_at, updated_at) VALUES
  (1, 'renewal_draft', 5, 'Review the renewal draft for Acme', '/invoices/5', NULL, '${T}', '${T}', '${T}'),
  (2, 'invoice_overdue', 1, 'INV-0001 for Acme is overdue', '/invoices/1', NULL, NULL, '${T}', '${T}'),
  (3, 'original_due', 1, 'Contabo invoice CTB-1 is due', '/originals/1', '${T}', NULL, '${T}', '${T}');
`

type Row = Record<string, unknown>

const userTables = (sqlite: Database.Database) =>
  (
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name)

const columnsOf = (sqlite: Database.Database, table: string) =>
  (sqlite.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name)

const rowsOf = (sqlite: Database.Database, table: string) =>
  sqlite.prepare(`SELECT * FROM "${table}" ORDER BY id`).all() as Row[]

/** Money columns whose totals must survive, by table. */
const SUMS: Record<string, string[]> = {
  invoices: [
    'subtotal',
    'tax',
    'total',
    'base_subtotal',
    'base_total',
    'paid_amount',
    'discount_amount',
    'revenue_adjust_base',
  ],
  invoice_lines: ['net', 'tax', 'total', 'cost_amount', 'cost_base'],
  invoice_payments: ['amount'],
  original_invoices: ['subtotal', 'tax', 'total', 'base_subtotal', 'base_total'],
  original_invoice_lines: ['total'],
  subscriptions: ['cost_amount', 'price_amount'],
  subscription_lines: ['cost_amount', 'price_amount'],
  services: ['default_cost', 'default_price'],
  number_sequences: ['next_value'],
}

function figures(sqlite: Database.Database) {
  const counts: Record<string, number> = {}
  const sums: Record<string, number> = {}
  for (const table of Object.keys(TABLES_BEFORE)) {
    counts[table] = (
      sqlite.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }
    ).n
  }
  for (const [table, columns] of Object.entries(SUMS)) {
    for (const column of columns) {
      sums[`${table}.${column}`] = (
        sqlite.prepare(`SELECT coalesce(sum(${column}), 0) AS s FROM "${table}"`).get() as {
          s: number
        }
      ).s
    }
  }
  return { counts, sums }
}

/** Every table before plan 22, filled with its rows. Set in `beforeAll`. */
let TABLES_BEFORE: Record<string, Row[]> = {}
let migrated: Database.Database
let before: ReturnType<typeof figures>

const drizzleTables = Object.values(schema)
  .flatMap((value) => (is(value, SQLiteTable) ? [value] : []))
  .map((table) => getTableConfig(table))

beforeAll(() => {
  migrated = openDatabase('existing.sqlite')
  migrateTo(migrated, preWorkspaceMigrations())
  expect(userTables(migrated)).not.toContain('workspaces')
  migrated.exec(FIXTURE)
  expect(migrated.pragma('foreign_key_check')).toEqual([])

  TABLES_BEFORE = Object.fromEntries(
    userTables(migrated).map((table) => [table, rowsOf(migrated, table)]),
  )
  const empty = Object.entries(TABLES_BEFORE).filter(([, rows]) => rows.length === 0)
  expect(
    empty.map(([table]) => table),
    'The fixture must fill every table',
  ).toEqual([])
  before = figures(migrated)

  migrateTo(migrated, MIGRATIONS)
})

afterAll(() => migrated?.close())

describe('migrating an existing database into workspace 1', () => {
  it('keeps every row, count and total', () => {
    expect(figures(migrated)).toEqual(before)
    for (const [table, rows] of Object.entries(TABLES_BEFORE)) {
      // Compare only the columns that existed before: later migrations may add columns.
      const columns = Object.keys(rows[0] ?? {})
      const after = rowsOf(migrated, table).map((row) =>
        Object.fromEntries(columns.map((column) => [column, row[column]])),
      )
      expect(after, table).toEqual(rows)
    }
  })

  it('puts every row in workspace 1', () => {
    for (const table of userTables(migrated)) {
      if (!columnsOf(migrated, table).includes('workspace_id')) continue
      const outside = migrated
        .prepare(`SELECT id, workspace_id FROM "${table}" WHERE workspace_id IS NOT 1`)
        .all()
      expect(outside, `${table} rows outside workspace 1`).toEqual([])
    }
    // Every domain table, and the sign-in tables, now carry it.
    for (const table of Object.keys(TABLES_BEFORE)) {
      if (table === 'users' || table === 'device_tokens') continue
      expect(columnsOf(migrated, table), table).toContain('workspace_id')
    }
  })

  it('creates workspace 1 and makes every user its owner', () => {
    expect(migrated.prepare('SELECT id, name FROM workspaces').all()).toEqual([
      { id: 1, name: 'My workspace' },
    ])
    const memberships = migrated
      .prepare('SELECT workspace_id, user_id, role FROM memberships ORDER BY user_id')
      .all()
    expect(memberships).toEqual([
      { workspace_id: 1, user_id: 1, role: 'owner' },
      { workspace_id: 1, user_id: 2, role: 'owner' },
    ])
  })

  it('keeps the owner signed in on web and on the phone', () => {
    expect(migrated.prepare('SELECT workspace_id, token_hash FROM auth_sessions').all()).toEqual([
      { workspace_id: 1, token_hash: 'session-hash' },
    ])
    expect(migrated.prepare('SELECT workspace_id, token_hash FROM api_tokens').all()).toEqual([
      { workspace_id: 1, token_hash: 'token-hash' },
    ])
    expect(migrated.prepare('SELECT api_token_id FROM device_tokens').all()).toEqual([
      { api_token_id: 1 },
    ])
  })

  it('leaves no broken references', () => {
    expect(migrated.pragma('foreign_key_check')).toEqual([])
    expect(migrated.pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it('rebuilds the unique indexes per workspace', () => {
    const expected: Record<string, [string, string[]]> = {
      sequence_per_issuer: ['number_sequences', ['workspace_id', 'issuer_key', 'type']],
      invoice_number_per_issuer: ['invoices', ['workspace_id', 'issuer_key', 'type', 'number']],
      one_reminder_per_ref: ['reminders', ['workspace_id', 'kind', 'ref_id']],
      settings_per_workspace: ['settings', ['workspace_id']],
    }
    for (const [name, [table, columns]] of Object.entries(expected)) {
      const list = migrated.pragma(`index_list(${table})`) as { name: string; unique: number }[]
      expect(list.find((index) => index.name === name)?.unique, name).toBe(1)
      const info = migrated.pragma(`index_info(${name})`) as { name: string }[]
      expect(
        info.map((c) => c.name),
        name,
      ).toEqual(columns)
    }
    const { sql } = migrated
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'invoice_number_per_issuer'")
      .get() as { sql: string }
    expect(sql, 'a voided number can be reused, so void rows stay out').toMatch(
      /WHERE status <> 'void'/i,
    )
  })

  it('matches the Drizzle schema, so the hand-written SQL and schema.ts agree', () => {
    for (const table of drizzleTables) {
      expect(new Set(columnsOf(migrated, table.name)), table.name).toEqual(
        new Set(table.columns.map((c) => c.name)),
      )
      const indexes = (migrated.pragma(`index_list(${table.name})`) as { name: string }[]).map(
        (index) => index.name,
      )
      for (const index of table.indexes) {
        expect(indexes, `${table.name} index`).toContain(index.config.name)
      }
    }
  })
})

describe('migrating a fresh database', () => {
  it('creates no workspace and no membership', () => {
    const fresh = openDatabase('fresh.sqlite')
    try {
      migrateTo(fresh, MIGRATIONS)
      expect(fresh.prepare('SELECT count(*) AS n FROM workspaces').get()).toEqual({ n: 0 })
      expect(fresh.prepare('SELECT count(*) AS n FROM memberships').get()).toEqual({ n: 0 })
      expect(fresh.pragma('foreign_key_check')).toEqual([])
    } finally {
      fresh.close()
    }
  })
})

describe('uniqueness after the migration', () => {
  const issue = (ws: number, id: number, number: string, customer: number, template: number) =>
    migrated
      .prepare(
        `INSERT INTO invoices (id, workspace_id, type, status, number, issuer_key, customer_id, template_id, currency, fx_rate, created_at, updated_at)
         VALUES (?, ?, 'invoice', 'issued', ?, 'tax:OM1100', ?, ?, 'USD', 100000000, '${T}', '${T}')`,
      )
      .run(id, ws, number, customer, template)

  beforeAll(() => {
    migrated.exec(`
      INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (2, 'Second', '${T}', '${T}');
      INSERT INTO customers (id, workspace_id, name, created_at, updated_at) VALUES (100, 2, 'Initech', '${T}', '${T}');
      INSERT INTO templates (id, workspace_id, name, kind, pdf_file, created_at, updated_at)
        VALUES (100, 2, 'System template', 'system', 'templates/00000000-0000-4000-8000-000000000100.pdf', '${T}', '${T}');
    `)
  })

  it('lets another workspace use the same number and issuer', () => {
    expect(() => issue(2, 100, 'INV-0001', 100, 100)).not.toThrow()
  })

  it('still refuses a duplicate number inside one workspace', () => {
    expect(() => issue(1, 101, 'INV-0001', 1, 1)).toThrow(/UNIQUE constraint failed/)
  })

  it('keeps sequences, reminders and settings per workspace', () => {
    const sequence = (ws: number) =>
      migrated
        .prepare(
          "INSERT INTO number_sequences (workspace_id, issuer_key, type, next_value) VALUES (?, 'tax:OM1100', 'invoice', 1)",
        )
        .run(ws)
    expect(() => sequence(2)).not.toThrow()
    expect(() => sequence(1)).toThrow(/UNIQUE constraint failed/)

    const reminder = (ws: number) =>
      migrated
        .prepare(
          `INSERT INTO reminders (workspace_id, kind, ref_id, message, link, created_at, updated_at) VALUES (?, 'renewal_draft', 5, 'x', '/', '${T}', '${T}')`,
        )
        .run(ws)
    expect(() => reminder(2)).not.toThrow()
    expect(() => reminder(1)).toThrow(/UNIQUE constraint failed/)

    const settings = (ws: number) =>
      migrated
        .prepare(
          `INSERT INTO settings (workspace_id, created_at, updated_at) VALUES (?, '${T}', '${T}')`,
        )
        .run(ws)
    expect(() => settings(2)).not.toThrow()
    expect(() => settings(1)).toThrow(/UNIQUE constraint failed/)
  })

  it('deletes a workspace with all its rows and nothing else', () => {
    migrated.prepare('DELETE FROM workspaces WHERE id = 2').run()
    for (const table of userTables(migrated)) {
      if (!columnsOf(migrated, table).includes('workspace_id')) continue
      expect(
        migrated.prepare(`SELECT count(*) AS n FROM "${table}" WHERE workspace_id = 2`).get(),
        table,
      ).toEqual({ n: 0 })
    }
    expect(figures(migrated).counts.invoices).toBe(before.counts.invoices)
    expect(migrated.pragma('foreign_key_check')).toEqual([])
  })
})
