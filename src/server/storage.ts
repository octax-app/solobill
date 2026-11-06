import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { config } from './config.ts'
import { ApiError } from './errors.ts'
import { r2 } from './r2.ts'

export type FileKind = 'pdf' | 'image' | 'font'

interface Sniffed {
  extension: string
  contentType: string
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]
const TRUETYPE = [0x00, 0x01, 0x00, 0x00]
const text = (value: string) => [...value].map((char) => char.charCodeAt(0))

const startsWith = (bytes: Uint8Array, signature: number[]) =>
  signature.every((value, index) => bytes[index] === value)

/** Checks the file's real content. The name and declared type are not trusted. */
export function sniff(bytes: Uint8Array): Sniffed | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { extension: 'pdf', contentType: 'application/pdf' }
  }
  if (startsWith(bytes, PNG)) return { extension: 'png', contentType: 'image/png' }
  if (startsWith(bytes, JPEG)) return { extension: 'jpg', contentType: 'image/jpeg' }
  if (startsWith(bytes, TRUETYPE) || startsWith(bytes, text('true'))) {
    return { extension: 'ttf', contentType: 'font/ttf' }
  }
  if (startsWith(bytes, text('OTTO'))) return { extension: 'otf', contentType: 'font/otf' }
  if (startsWith(bytes, text('wOFF'))) return { extension: 'woff', contentType: 'font/woff' }
  return null
}

const ACCEPTED: Record<FileKind, { extensions: string[]; refusal: string }> = {
  pdf: { extensions: ['pdf'], refusal: 'Upload a PDF file' },
  image: { extensions: ['png', 'jpg'], refusal: 'Upload a PNG or JPEG image' },
  font: {
    extensions: ['ttf', 'otf', 'woff'],
    refusal: 'Upload a TTF, OTF or WOFF font. WOFF2 is not supported.',
  },
}

/** Why these bytes cannot be stored as this kind of file, or null when they can. */
export function fileProblem(bytes: Uint8Array, kind: FileKind): string | null {
  const extension = sniff(bytes)?.extension
  return extension && ACCEPTED[kind].extensions.includes(extension) ? null : ACCEPTED[kind].refusal
}

const KEY_PATTERN = /^[a-z]+\/[0-9a-f-]{36}\.(pdf|png|jpg|ttf|otf|woff)$/

/** Only keys this module created are accepted, which rules out path traversal. */
function assertKey(key: string) {
  if (!KEY_PATTERN.test(key)) throw new ApiError(404, 'File not found')
}

const objectKey = (key: string) => `files/${key}`
const localPath = (key: string) => path.join(config.filesDir, key)

export async function saveFile(folder: string, bytes: Uint8Array, kind: FileKind): Promise<string> {
  if (bytes.byteLength > config.maxUploadBytes) {
    throw new ApiError(413, 'File is larger than the 20 MB limit')
  }
  const problem = fileProblem(bytes, kind)
  if (problem) throw new ApiError(415, problem)
  const sniffed = sniff(bytes) as Sniffed
  const key = `${folder}/${randomUUID()}.${sniffed.extension}`
  const bucket = r2()
  if (bucket) {
    await bucket.client.send(
      new PutObjectCommand({
        Bucket: bucket.bucket,
        Key: objectKey(key),
        Body: bytes,
        ContentType: sniffed.contentType,
      }),
    )
    return key
  }
  await fs.mkdir(path.dirname(localPath(key)), { recursive: true })
  await fs.writeFile(localPath(key), bytes)
  return key
}

export async function readFile(key: string): Promise<Uint8Array> {
  assertKey(key)
  try {
    const bucket = r2()
    if (!bucket) return await fs.readFile(localPath(key))
    const result = await bucket.client.send(
      new GetObjectCommand({ Bucket: bucket.bucket, Key: objectKey(key) }),
    )
    if (!result.Body) throw new Error('Empty object')
    return await result.Body.transformToByteArray()
  } catch (error) {
    const name = (error as { name?: string; code?: string }).name
    const code = (error as { name?: string; code?: string }).code
    if (name === 'NoSuchKey' || code === 'ENOENT') throw new ApiError(404, 'File not found')
    throw error
  }
}

export async function removeFile(key: string | null | undefined) {
  if (!key) return
  assertKey(key)
  const bucket = r2()
  if (bucket) {
    await bucket.client.send(
      new DeleteObjectCommand({ Bucket: bucket.bucket, Key: objectKey(key) }),
    )
  } else {
    await fs.rm(localPath(key), { force: true })
  }
}
