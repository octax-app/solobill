import { Cron } from 'croner'
import { runBackup } from './backup.ts'
import { deliverReminders } from './services/push.ts'
import { runReminders, runRenewals } from './services/renewals.ts'

export async function runDaily() {
  try {
    runRenewals()
    runReminders()
    await deliverReminders()
  } catch (error) {
    console.error('Daily job failed', error)
  }
}

export function startJobs() {
  runDaily()
  new Cron('0 5 * * *', { timezone: 'UTC' }, runDaily)
  new Cron('30 2 * * *', { timezone: 'UTC' }, async () => {
    try {
      await runBackup()
    } catch (error) {
      console.error('Backup failed', error)
    }
  })
}
