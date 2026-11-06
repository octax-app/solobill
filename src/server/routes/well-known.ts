import { Hono } from 'hono'
import { config } from '../config.ts'

/**
 * Lets the website and the apps share saved passwords (plan 23). Public JSON, never a redirect,
 * and 404 while the settings are empty. Apple's CDN caches the association file for a while.
 */
export const wellKnownRoutes = new Hono()

wellKnownRoutes.get('/.well-known/apple-app-site-association', (c) => {
  const apps = config.appLinks.appleAppIds
  if (!apps.length) return c.json({ error: 'Not found' }, 404)
  return c.json({ webcredentials: { apps } })
})

wellKnownRoutes.get('/.well-known/assetlinks.json', (c) => {
  const android = config.appLinks.android
  if (!android?.sha256.length) return c.json({ error: 'Not found' }, 404)
  return c.json([
    {
      relation: ['delegate_permission/common.get_login_creds'],
      target: {
        namespace: 'android_app',
        package_name: android.packageName,
        sha256_cert_fingerprints: android.sha256,
      },
    },
  ])
})
