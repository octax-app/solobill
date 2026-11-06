import { is } from 'drizzle-orm'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import * as schema from '../db/schema.ts'

/**
 * Tables that are not owned by one workspace (plan 22). `memberships` links a user to a
 * workspace and has `workspace_id` anyway. Add a table here only when it is truly global.
 */
const GLOBAL_TABLES = new Set([
  'workspaces',
  'users',
  'memberships',
  'device_tokens',
  // Plan 23: sign-in data belongs to a person, not a workspace.
  'user_identities',
  'email_tokens',
])

/** Unique indexes that must be per workspace, so two workspaces can use the same values. */
const PER_WORKSPACE_UNIQUE = [
  'sequence_per_issuer',
  'invoice_number_per_issuer',
  'one_reminder_per_ref',
  'settings_per_workspace',
]

const HOW_TO_FIX =
  'Every domain table belongs to a workspace (docs/ARCHITECTURE.md, rule 12). ' +
  'Add `workspaceId: workspaceId()` and an index that starts with it, e.g. ' +
  "`index('<table>_workspace').on(t.workspaceId)`, then run `pnpm db:generate` and check the " +
  'migration fills the column for existing rows. Only a truly global table may go in ' +
  'GLOBAL_TABLES in this test.'

const tables = Object.values(schema)
  .flatMap((value) => (is(value, SQLiteTable) ? [value] : []))
  .map((table) => getTableConfig(table))

const indexColumns = (index: (typeof tables)[number]['indexes'][number]) =>
  index.config.columns.map((column) => ('name' in column ? column.name : String(column)))

describe('schema guard', () => {
  it('finds the tables', () => {
    expect(tables.length).toBeGreaterThan(15)
    expect(tables.map((t) => t.name)).toContain('invoices')
  })

  it.each(tables.filter((t) => !GLOBAL_TABLES.has(t.name)).map((t) => [t.name, t] as const))(
    '%s has workspace_id and an index that starts with it',
    (name, table) => {
      const column = table.columns.find((c) => c.name === 'workspace_id')
      expect(column, `Table "${name}" has no workspace_id column. ${HOW_TO_FIX}`).toBeDefined()
      expect(column?.notNull, `"${name}".workspace_id must be NOT NULL. ${HOW_TO_FIX}`).toBe(true)

      const foreignKey = table.foreignKeys.find((fk) =>
        fk.reference().columns.some((c) => c.name === 'workspace_id'),
      )
      expect(
        foreignKey && getTableConfig(foreignKey.reference().foreignTable).name,
        `"${name}".workspace_id must reference workspaces(id). ${HOW_TO_FIX}`,
      ).toBe('workspaces')
      expect(
        foreignKey?.onDelete,
        `"${name}".workspace_id must cascade on delete, so deleting a workspace removes its ` +
          `rows. ${HOW_TO_FIX}`,
      ).toBe('cascade')

      const indexed = table.indexes.some((index) => indexColumns(index)[0] === 'workspace_id')
      expect(
        indexed,
        `Table "${name}" has no index whose first column is workspace_id. ${HOW_TO_FIX}`,
      ).toBe(true)
    },
  )

  it.each(PER_WORKSPACE_UNIQUE)('unique index %s starts with workspace_id', (indexName) => {
    const index = tables.flatMap((t) => t.indexes).find((i) => i.config.name === indexName)
    expect(index, `Unique index ${indexName} is missing from the schema`).toBeDefined()
    expect(index?.config.unique).toBe(true)
    expect(
      indexColumns(index as NonNullable<typeof index>)[0],
      `Unique index ${indexName} must start with workspace_id, or one workspace's values ` +
        `would block another's (plan 22).`,
    ).toBe('workspace_id')
  })

  it('lists only real tables as global', () => {
    const names = new Set(tables.map((t) => t.name))
    for (const name of GLOBAL_TABLES) expect(names.has(name), name).toBe(true)
  })
})
