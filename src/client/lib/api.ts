import { QueryClient, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'

const BASE = '/api/v1'

export class RequestError extends Error {
  status: number
  link?: string
  constructor(status: number, message: string, link?: string) {
    super(message)
    this.status = status
    this.link = link
  }
}

async function send<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const isForm = body instanceof FormData
  const res = await fetch(`${BASE}${path}`, {
    method,
    signal,
    credentials: 'same-origin',
    headers: body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
  })
  const type = res.headers.get('content-type') ?? ''
  if (!res.ok) {
    const data = type.includes('json') ? await res.json() : null
    throw new RequestError(
      res.status,
      data?.error ?? 'Something went wrong. Try again.',
      data?.link,
    )
  }
  return (type.includes('json') ? res.json() : res.blob()) as Promise<T>
}

export const api = {
  get: <T>(path: string) => send<T>('GET', path),
  post: <T = unknown>(path: string, body?: unknown) => send<T>('POST', path, body),
  put: <T = unknown>(path: string, body: unknown) => send<T>('PUT', path, body),
  patch: <T = unknown>(path: string, body: unknown) => send<T>('PATCH', path, body),
  del: <T = unknown>(path: string, body?: unknown) => send<T>('DELETE', path, body),
  blob: (path: string, body?: unknown, options?: { signal?: AbortSignal }) =>
    send<Blob>(body === undefined ? 'GET' : 'POST', path, body, options?.signal),
  upload: <T = unknown>(path: string, file: File, extra: Record<string, string> = {}) => {
    const form = new FormData()
    form.append('file', file)
    for (const [key, value] of Object.entries(extra)) form.append(key, value)
    return send<T>('POST', path, form)
  },
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof RequestError) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
})

export function useApi<T>(path: string | null) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: () => api.get<T>(path as string),
    enabled: path !== null,
  })
}

/** Runs a change, refreshes all data, and reports the result. */
export async function run<T>(task: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const result = await task()
    await queryClient.invalidateQueries()
    if (success) toast.success(success)
    return result
  } catch (error) {
    const link = error instanceof RequestError ? error.link : undefined
    toast.error(error instanceof Error ? error.message : 'Something went wrong. Try again.', {
      action: link ? { label: 'Open', onClick: () => window.location.assign(link) } : undefined,
    })
    return undefined
  }
}

export const fileUrl = (key: string) => `${BASE}/files/${key}`

/**
 * Full-page navigation target for a Google or Apple sign-in, or for linking one in Settings.
 * `returnTo` is a path on this site to come back to; the server ignores anything else.
 */
export const oauthStartUrl = (
  provider: 'google' | 'apple',
  intent: 'signin' | 'link',
  returnTo?: string,
) =>
  `${BASE}/auth/oauth/${provider}/start?intent=${intent}${
    returnTo ? `&return=${encodeURIComponent(returnTo)}` : ''
  }`
