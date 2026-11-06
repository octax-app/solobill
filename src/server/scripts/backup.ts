import { runBackup } from '../backup.ts'

console.log(`Backup written to ${await runBackup()}`)
