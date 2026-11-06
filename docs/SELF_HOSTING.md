# Self-hosting

Octax Solobill runs as a single Docker container with a SQLite database on a volume. You need:

- A Linux server with Docker and Docker Compose.
- A domain, served over HTTPS by a reverse proxy (Caddy, Nginx, Traefik or Cloudflare Tunnel). The
  server refuses to start in production unless `APP_URL` is an `https://` address.
- Optional: an S3-compatible bucket such as Cloudflare R2 for files and off-site backups.
- Optional: SMTP for sign-up, email verification and password reset.

The image is published at `ghcr.io/octax-app/solobill` for `linux/amd64` and `linux/arm64`.

| Tag | What it is |
|---|---|
| `latest` | The newest build of `main` |
| `1.2.3`, `1.2` | Releases |
| `sha-abc1234` | One exact commit |

## Quick start

1. Get the Compose files and the example settings:

   ```sh
   git clone https://github.com/octax-app/solobill.git && cd solobill
   cp .env.example .env.production
   ```

2. Edit `.env.production`. For a private install, these are enough:

   ```sh
   APP_URL=https://solobill.example.com
   REGISTRATION_OPEN=false
   ```

3. Start it:

   ```sh
   docker compose up -d
   ```

   The app listens on `127.0.0.1:3000`. Point your reverse proxy at it. With Caddy, for example:

   ```
   solobill.example.com {
     reverse_proxy 127.0.0.1:3000
   }
   ```

4. Create the first account:

   ```sh
   docker compose exec web node src/server/scripts/admin.ts you@example.com 'a-long-password'
   ```

   Run the same command again to reset that account's password. Add `--reset-totp` to turn off its
   two-step login.

### Compose settings

Set these in your shell or in a `.env` file next to `compose.yml`. That file is only read by
Compose. The app's own settings go in `.env.production`.

| Variable | Default | Purpose |
|---|---|---|
| `SOLOBILL_VERSION` | `latest` | Image tag to run |
| `SOLOBILL_PORT` | `3000` | Port on `127.0.0.1` |
| `SOLOBILL_DATA_VOLUME` | `solobill_data` | Docker volume that holds the database. Set it to reuse an existing volume |

To build the image from source instead of pulling it, run `docker compose up -d --build`.

## Behind an existing Traefik

`compose.traefik.yml` adds an Nginx container and joins Traefik's network. Traefik terminates HTTPS
and Nginx passes requests to the app.

```sh
APP_DOMAIN=solobill.example.com docker compose -f compose.traefik.yml up -d
```

| Variable | Default | Purpose |
|---|---|---|
| `APP_DOMAIN` | required | Host name Traefik routes to the app |
| `TRAEFIK_NETWORK` | `proxy` | Traefik's external Docker network. This project never creates or removes it |
| `TRAEFIK_ENTRYPOINT` | `websecure` | Traefik's HTTPS entry point |
| `TRAEFIK_CERTRESOLVER` | `letsencrypt` | Traefik certificate resolver |

After editing `nginx.conf`, run `docker compose -f compose.traefik.yml restart nginx`.

## Behind Cloudflare

- Set SSL/TLS to **Full (strict)**. Other modes cause redirect loops, or leave the connection from
  Cloudflare to your server unencrypted.
- Do not add a Cache Everything rule. The API sends `no-store`, and customer data must never be
  cached at the edge.
- Do not let Cloudflare redirect or challenge `/.well-known/*` or
  `/api/v1/auth/oauth/apple/callback`. Apple posts to that callback from its own servers.
- Sign-in limits count failures per client IP from `X-Real-IP`. Make your proxy trust Cloudflare's
  IP ranges for forwarded headers, or every visitor shares one address. In Traefik that is
  `forwardedHeaders.trustedIPs` on the entry point.

## File storage

Uploaded PDFs, logos, fonts and generated invoices go to an S3-compatible bucket when these are set
in `.env.production`:

```sh
R2_ACCOUNT_ID=
R2_BUCKET=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
```

The variables are named for Cloudflare R2, which is what the app is tested with. Without them, files
are kept in the data volume under `/data/files`. That works, but then one volume holds everything,
so back it up yourself.

Stored files are only ever served through authenticated routes, and object names are random. That
stays safe even if your bucket has a public domain.

## Backups and restore

A database backup runs every night at 02:30 UTC. The last 3 archives are kept in `/data/backups`.
When storage is configured, each one is also uploaded to the bucket under `backups/`, and the last
30 are kept there. Without a bucket, copy `/data/backups` off the server yourself.

Run one by hand:

```sh
docker compose exec web node src/server/scripts/backup.ts
```

Restore the newest backup from the bucket:

```sh
docker compose stop web
docker compose run --rm --no-deps web node src/server/scripts/restore.ts
docker compose start web
```

Add a path after `restore.ts`, such as `/data/backups/<file>.db.gz`, to restore a local archive
instead.

## Updating

```sh
docker compose pull && docker compose up -d
```

Migrations run automatically on start. Take a backup before updating across a release that changes
the database. Compose stops the old container before starting the new one, so expect a few seconds of
downtime.

## Scaling

Run exactly one `web` container. SQLite allows one writer, and invoice numbering and sign-in limits
are protected inside the single process. A bigger server is the way to grow.

## Sign-up and email

Each part is off until its settings are filled in. Restart with `docker compose up -d` after changing
`.env.production`.

1. **Address.** `APP_URL=https://solobill.example.com`, with no trailing slash. Email links and
   sign-in redirects are built from it.
2. **Email.** `SMTP_URL=smtps://user:password@host:465` and
   `MAIL_FROM="Octax Solobill <no-reply@example.com>"`. Any SMTP service works. Set up SPF and DKIM
   for the sending domain, or emails land in spam. Outside production, emails are printed to the
   console instead.
3. **Open sign-up.** `REGISTRATION_OPEN=true` lets anyone create an account, each with its own
   isolated workspace. The server refuses to start with sign-up open and no SMTP. Existing users can
   always sign in.

## Google sign-in

In Google Cloud, open APIs & Services, then Credentials:

- Create a **Web application** client with the redirect URI
  `https://solobill.example.com/api/v1/auth/oauth/google/callback`. Set `GOOGLE_WEB_CLIENT_ID` and
  `GOOGLE_WEB_CLIENT_SECRET`.
- For your own iOS build, create an **iOS** client for its bundle id and set `GOOGLE_IOS_CLIENT_ID`.
  The app reads it from the server.
- On the OAuth consent screen, publish the app (not Testing) with the `openid`, `email` and `profile`
  scopes.

## Apple: push notifications and Sign in with Apple

These only matter if you build and ship your own copy of the
[iOS app](https://github.com/octax-app/solobill-ios). Push notifications have to be sent with the
Apple Developer account that signed the app.

1. In your Apple Developer account, open Certificates, Identifiers & Profiles, then Keys. Create a
   key with **Apple Push Notifications service** enabled, and download the `.p8` file. Apple only
   offers the download once. Enable **Sign in with Apple** on the same key to use it for both.
2. Add to `.env.production`:

   ```sh
   APNS_KEY_BASE64=   # the output of: base64 -i AuthKey_XXXXXXXXXX.p8
   APNS_KEY_ID=       # the 10-character key id
   APNS_TEAM_ID=      # your 10-character Team ID
   APNS_BUNDLE_ID=    # your app's bundle id
   ```

3. For Sign in with Apple on the web, create a **Services ID**, for example `<bundle id>.web`. Turn
   on Sign in with Apple with your domain and the return URL
   `https://solobill.example.com/api/v1/auth/oauth/apple/callback`. Set `APPLE_SERVICES_ID`.

The other `APPLE_` settings fall back to the `APNS_` values. Set `APPLE_KEY_ID` and
`APPLE_PRIVATE_KEY_BASE64` only to use a separate key. Revoking a shared key stops both push and
Apple sign-in until it is replaced.

Reminders go out with the daily job at 05:00 UTC, and once whenever the server starts.

## Password autofill with the apps

With the Apple team and bundle id set, the server serves
`/.well-known/apple-app-site-association`, so the iOS app can use passwords saved for the website.
Check it after deploying:

```sh
curl -i https://solobill.example.com/.well-known/apple-app-site-association
```

It must return `200` and `application/json` with no redirect. Apple's CDN can take a day to pick it
up.

For Android, set `ANDROID_PACKAGE_NAME` and `ANDROID_CERT_SHA256` (comma separated, including the
Play app signing fingerprint) to serve `/.well-known/assetlinks.json`.
