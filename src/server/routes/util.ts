import type { Context, MiddlewareHandler } from 'hono'
import type { z } from 'zod'
import { ApiError } from '../errors.ts'

export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  let json: unknown
  try {
    json = await c.req.json()
  } catch {
    throw new ApiError(400, 'The request body is not valid JSON')
  }
  return schema.parse(json)
}

export function idParam(c: Context, name = 'id'): number {
  const value = Number(c.req.param(name))
  if (!Number.isInteger(value) || value <= 0) throw new ApiError(404, 'Not found')
  return value
}

export async function uploaded(c: Context, field = 'file'): Promise<Uint8Array> {
  const form = await c.req.parseBody()
  const file = form[field]
  if (!(file instanceof File)) throw new ApiError(422, 'Choose a file to upload')
  return new Uint8Array(await file.arrayBuffer())
}

function withoutWorkspaceId(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutWorkspaceId)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'workspaceId')
        .map(([key, item]) => [key, withoutWorkspaceId(item)]),
    )
  }
  return value
}

/** Routers mounted at the same path all match, so a reply is rewritten only once. */
const hidden = new WeakSet<Response>()

/**
 * Rows carry `workspaceId`, but the API shape does not, so JSON replies drop that key. Files and
 * PDFs pass through untouched.
 */
export const hideWorkspaceId: MiddlewareHandler = async (c, next) => {
  await next()
  if (hidden.has(c.res)) return
  if (!c.res.headers.get('content-type')?.includes('application/json')) return
  const json = await c.res.clone().json()
  const headers = new Headers(c.res.headers)
  headers.delete('content-length')
  const res = new Response(JSON.stringify(withoutWorkspaceId(json)), {
    status: c.res.status,
    headers,
  })
  hidden.add(res)
  c.res = undefined
  c.res = res
}
