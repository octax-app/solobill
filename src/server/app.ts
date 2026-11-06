import fs from 'node:fs/promises'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import { ZodError } from 'zod'
import { type AuthEnv, requireAuth } from './auth.ts'
import { config } from './config.ts'
import { sqlite } from './db/index.ts'
import { ApiError } from './errors.ts'
import { authRoutes } from './routes/auth.ts'
import { catalogRoutes } from './routes/catalog.ts'
import { fontRoutes } from './routes/fonts.ts'
import { invoiceRoutes } from './routes/invoices.ts'
import { miscRoutes } from './routes/misc.ts'
import { templateRoutes } from './routes/templates.ts'
import { wellKnownRoutes } from './routes/well-known.ts'
import { workspaceRoutes } from './routes/workspace.ts'

export function createApp() {
  const app = new Hono<AuthEnv>()

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        frameSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    }),
  )

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: error.message, link: error.link }, error.status)
    }
    if (error instanceof HTTPException) return error.getResponse()
    if (error instanceof ZodError) {
      const first = error.issues[0]
      return c.json(
        {
          error: first?.message ?? 'Check the form and try again',
          fields: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        422,
      )
    }
    if (error instanceof RangeError) return c.json({ error: error.message }, 422)
    console.error(error)
    return c.json({ error: 'Something went wrong on the server' }, 500)
  })

  // Before the SPA fallback, so these never fall through to index.html.
  app.route('/', wellKnownRoutes)

  app.get('/health', (c) => {
    sqlite.prepare('select 1').get()
    return c.json({ ok: true })
  })

  const api = new Hono<AuthEnv>()
  // Cloudflare caches by file extension, and routes here can end in .pdf or .png.
  // Nothing under the API may be stored at the edge, including error responses.
  api.use('*', async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'private, no-store')
  })

  // Browsers always send Origin on writes. A missing Origin means a non-browser client,
  // such as the iOS app, which authenticates with a bearer token rather than a cookie.
  api.use('*', async (c, next) => {
    const origin = c.req.header('origin')
    // Apple's web sign-in answers with a cross-site form POST (plan 23). That one route is
    // protected instead by the HMAC-signed state cookie (state must match, single use, 10-minute
    // expiry), the nonce, and the ID token check. It never uses the session cookie.
    const appleCallback =
      c.req.method === 'POST' && c.req.path === '/api/v1/auth/oauth/apple/callback'
    if (origin && !appleCallback && !['GET', 'HEAD'].includes(c.req.method)) {
      const host = c.req.header('x-forwarded-host') ?? c.req.header('host')
      const originHost = URL.canParse(origin) ? new URL(origin).host : null
      // In development the UI is on Vite's port and proxies to this server.
      const devUi = !config.production && /^(localhost|127\.0\.0\.1):5173$/.test(originHost ?? '')
      if (originHost !== host && !devUi) {
        throw new ApiError(403, 'This request came from another site')
      }
    }
    await next()
  })
  api.use(
    '*',
    bodyLimit({
      maxSize: config.maxUploadBytes + 1024 * 1024,
      onError: () => {
        throw new ApiError(413, 'File is larger than the 20 MB limit')
      },
    }),
  )
  api.route('/auth', authRoutes)

  const secured = new Hono<AuthEnv>()
  secured.use('*', requireAuth)
  secured.route('/templates', templateRoutes)
  secured.route('/fonts', fontRoutes)
  secured.route('/', catalogRoutes)
  secured.route('/', invoiceRoutes)
  secured.route('/', miscRoutes)
  secured.route('/', workspaceRoutes)
  api.route('/', secured)

  app.route('/api/v1', api)
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))

  if (config.production) {
    const root = path.resolve(import.meta.dirname, '../../dist')
    app.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), root) }))
    app.get('*', async (c) => c.html(await fs.readFile(path.join(root, 'index.html'), 'utf8')))
  }

  return app
}
