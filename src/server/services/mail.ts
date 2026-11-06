import nodemailer, { type Transporter } from 'nodemailer'
import { config } from '../config.ts'

/**
 * Account emails (plan 23). Short plain text with a simple HTML version, and never any customer or
 * financial data. Sent through SMTP when `SMTP_URL` is set. Without it, outside production, the
 * email is written to the console so local development works; under tests it goes to `sentMail`.
 */
export interface Mail {
  to: string
  subject: string
  text: string
  html: string
}

/** Every email sent while NODE_ENV is test, newest last. Tests clear it as they like. */
export const sentMail: Mail[] = []

const testing = process.env.NODE_ENV === 'test'
let transporter: Transporter | null = null

/** In production with sign-up open, an account email that can't be sent locks people out. */
/**
 * Email links and Google and Apple redirects are built from APP_URL. Without it they point at
 * localhost, and Google answers redirect_uri_mismatch, so production refuses to start.
 */
export function assertAppUrl() {
  if (!config.production) return
  let url: URL | null = null
  try {
    url = new URL(config.appUrl)
  } catch {}
  const valid =
    config.appUrlSet &&
    url?.protocol === 'https:' &&
    // `new URL` reads `http:https://host` as the host "https", so the text must equal the origin.
    config.appUrl === url.origin
  if (!valid) {
    throw new Error(
      `APP_URL must be the public https address and nothing else, for example APP_URL=https://solobill.example.com (got "${config.appUrl}")`,
    )
  }
}

export function assertMailConfigured() {
  if (config.production && config.registrationOpen && !config.mail) {
    throw new Error(
      'REGISTRATION_OPEN is true but SMTP_URL is not set. Set SMTP_URL and MAIL_FROM, or set REGISTRATION_OPEN=false.',
    )
  }
}

/**
 * Sends without making the caller wait, so a request's timing doesn't show whether an email went
 * out. Under tests the email is recorded before this returns.
 */
export function queueMail(mail: Mail) {
  deliver(mail).catch((error) => {
    console.error(`Could not send the "${mail.subject}" email`, error)
  })
}

async function deliver(mail: Mail) {
  if (testing) {
    sentMail.push(mail)
    return
  }
  if (config.mail) {
    transporter ??= nodemailer.createTransport(config.mail.smtpUrl)
    await transporter.sendMail({ from: config.mail.from, ...mail })
    return
  }
  if (config.production) {
    console.error(`Email "${mail.subject}" was not sent: SMTP_URL is not set`)
    return
  }
  const link = mail.text.match(/https?:\/\/\S+/)?.[0]
  console.log(`[mail] to ${mail.to}: ${mail.subject}${link ? `\n[mail] ${link}` : ''}`)
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

/** Paragraphs of text, with an optional button-style link after them. */
function compose(to: string, subject: string, paragraphs: string[], link?: [string, string]): Mail {
  const text = [...paragraphs, ...(link ? [`${link[0]}: ${link[1]}`] : [])].join('\n\n')
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`)
  if (link) body.push(`<p><a href="${escapeHtml(link[1])}">${escapeHtml(link[0])}</a></p>`)
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">${body.join('')}</body></html>`
  return { to, subject, text: `${text}\n`, html }
}

export const verificationMail = (to: string, link: string) =>
  compose(
    to,
    'Confirm your email',
    [
      'Confirm your email address to finish creating your Octax Solobill account.',
      'The link works once and expires in 24 hours. If you did not sign up, ignore this email.',
    ],
    ['Confirm email', link],
  )

export const resetMail = (to: string, link: string) =>
  compose(
    to,
    'Reset your password',
    [
      'Someone asked to reset the password of your Octax Solobill account.',
      'The link works once and expires in 1 hour. Resetting signs you out everywhere. If you did not ask for this, ignore this email.',
    ],
    ['Choose a new password', link],
  )

export const alreadyRegisteredMail = (to: string) =>
  compose(to, 'You already have an account', [
    'Someone tried to create an Octax Solobill account with this email address, but you already have one.',
    `Sign in: ${config.appUrl}/login`,
    `Forgot your password? Reset it: ${config.appUrl}/forgot-password`,
    'If this was not you, ignore this email. Nothing has changed.',
  ])

export const passwordChangedMail = (to: string) =>
  compose(to, 'Your password was changed', [
    'The password of your Octax Solobill account was just changed.',
    `If this was not you, reset your password now: ${config.appUrl}/forgot-password`,
  ])
