import { S3Client } from '@aws-sdk/client-s3'
import { config } from './config.ts'

let client: S3Client | null = null

export function r2() {
  if (!config.r2) return null
  client ??= new S3Client({
    region: 'auto',
    endpoint: config.r2.endpoint,
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  return { client, bucket: config.r2.bucket }
}
