import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Runs before each test file, so every file gets its own stored files. Tests that count files
 * in storage would otherwise see files written by other files running in parallel.
 */
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'solobill-test-'))
