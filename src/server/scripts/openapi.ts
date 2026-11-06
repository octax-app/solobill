import fs from 'node:fs'
import path from 'node:path'
import { openApiDocument } from '../openapi.ts'

const file = path.resolve(import.meta.dirname, '../../../openapi.json')
fs.writeFileSync(file, `${JSON.stringify(openApiDocument(), null, 2)}\n`)
console.log(`Wrote ${file}`)
