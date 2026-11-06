import { type FormEvent, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import {
  FieldError,
  fieldErrors,
  oauthErrorMessage,
  PROVIDER_LABEL,
  useProviders,
} from '@/components/auth'
import { Confirm, Field, Loading } from '@/components/common'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { api, oauthStartUrl, queryClient, run, useApi } from '@/lib/api'
import type { Identity, Me } from '@/lib/types'
import { changePasswordInput, PASSWORD_MIN, type ProviderName } from '../../shared/auth.ts'

const PROVIDERS: ProviderName[] = ['google', 'apple']

/** Tells password managers which saved login a password field belongs to. */
function UsernameHint({ email }: { email: string }) {
  return <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
}

function Profile({ me }: { me: Me }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <p className="text-sm">
            {me.name || <span className="text-muted-foreground">Not set</span>}
          </p>
        </Field>
        <Field label="Email">
          <p className="text-sm break-all">{me.email}</p>
        </Field>
      </CardContent>
    </Card>
  )
}

function SignInMethods({ me, identities }: { me: Me; identities: Identity[] }) {
  const providers = useProviders()
  const linked = new Map(identities.map((identity) => [identity.provider, identity]))
  const shown = PROVIDERS.filter((name) => linked.has(name) || providers.data?.[name])
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign-in methods</CardTitle>
        <CardDescription>The ways you can log in to this account.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium">Email and password</div>
            <div className="text-muted-foreground text-xs">{me.email}</div>
          </div>
          <Badge variant={me.hasPassword ? 'secondary' : 'outline'}>
            {me.hasPassword ? 'Password set' : 'No password'}
          </Badge>
        </div>
        {shown.map((name) => {
          const identity = linked.get(name)
          return (
            <div key={name} className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">{PROVIDER_LABEL[name]}</div>
                <div className="text-muted-foreground text-xs">
                  {identity
                    ? `${identity.email ?? 'Linked'} · since ${identity.createdAt.slice(0, 10)}`
                    : 'Not linked'}
                </div>
              </div>
              {identity ? (
                <Confirm
                  title={`Unlink ${PROVIDER_LABEL[name]}?`}
                  description={`You will no longer be able to log in with ${PROVIDER_LABEL[name]}.`}
                  action="Unlink"
                  onConfirm={() =>
                    run(
                      () => api.del(`/auth/identities/${name}`),
                      `${PROVIDER_LABEL[name]} unlinked`,
                    )
                  }
                >
                  <Button size="sm" variant="ghost">
                    Unlink
                  </Button>
                </Confirm>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => window.location.assign(oauthStartUrl(name, 'link'))}
                >
                  Link {PROVIDER_LABEL[name]}
                </Button>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function Password({ hasPassword, email }: { hasPassword: boolean; email: string }) {
  const empty = { currentPassword: '', newPassword: '', confirm: '' }
  const [form, setForm] = useState(empty)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function submit(event: FormEvent) {
    event.preventDefault()
    const parsed = changePasswordInput.safeParse({
      currentPassword: hasPassword ? form.currentPassword : undefined,
      newPassword: form.newPassword,
    })
    const next = parsed.success ? {} : fieldErrors(parsed.error)
    if (hasPassword && !form.currentPassword) next.currentPassword = 'Enter your current password'
    if (form.confirm !== form.newPassword) next.confirm = 'The passwords don’t match'
    setErrors(next)
    if (!parsed.success || Object.keys(next).length > 0) return
    const done = await run(
      () => api.post('/auth/password', parsed.data),
      hasPassword ? 'Password changed' : 'Password set',
    )
    if (done) setForm(empty)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{hasPassword ? 'Change password' : 'Set a password'}</CardTitle>
        <CardDescription>
          {hasPassword
            ? 'The password you use to log in with your email address.'
            : 'Add a password so you can also log in with your email address.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit} noValidate>
          <UsernameHint email={email} />
          {hasPassword && (
            <Field label="Current password" className="sm:col-span-2">
              <Input
                type="password"
                name="currentPassword"
                autoComplete="current-password"
                value={form.currentPassword}
                onChange={(event) => setForm({ ...form, currentPassword: event.target.value })}
              />
              <FieldError>{errors.currentPassword}</FieldError>
            </Field>
          )}
          <Field
            label="New password"
            hint={`At least ${PASSWORD_MIN} characters.`}
            className="content-start"
          >
            <Input
              type="password"
              name="newPassword"
              autoComplete="new-password"
              value={form.newPassword}
              onChange={(event) => setForm({ ...form, newPassword: event.target.value })}
            />
            <FieldError>{errors.newPassword}</FieldError>
          </Field>
          <Field label="Confirm new password" className="content-start">
            <Input
              type="password"
              name="confirm"
              autoComplete="new-password"
              value={form.confirm}
              onChange={(event) => setForm({ ...form, confirm: event.target.value })}
            />
            <FieldError>{errors.confirm}</FieldError>
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit">{hasPassword ? 'Change password' : 'Set password'}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function TwoStep({
  enabled,
  hasPassword,
  email,
}: {
  enabled: boolean
  hasPassword: boolean
  email: string
}) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null)
  const [code, setCode] = useState('')
  const [secret, setSecret] = useState('')
  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-step login</CardTitle>
        <CardDescription>
          {enabled
            ? 'On. You need a code from your authenticator app to log in with your password.'
            : 'Off. Turn it on to require a code from an authenticator app when you log in with your password.'}{' '}
          Google and Apple use their own two-step login.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {enabled ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={async (event) => {
              event.preventDefault()
              await run(
                () =>
                  api.post(
                    '/auth/totp/disable',
                    hasPassword ? { password: secret } : { code: secret },
                  ),
                'Two-step login turned off',
              )
              setSecret('')
            }}
          >
            {hasPassword && <UsernameHint email={email} />}
            {hasPassword ? (
              <Field label="Password">
                <Input
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                />
              </Field>
            ) : (
              <Field label="6-digit code">
                <Input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                />
              </Field>
            )}
            <Button type="submit" variant="outline" disabled={!secret}>
              Turn off
            </Button>
          </form>
        ) : setup ? (
          <>
            <p className="text-sm">Add this secret to your authenticator app:</p>
            <code className="bg-muted rounded p-2 text-sm break-all">{setup.secret}</code>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={async (event) => {
                event.preventDefault()
                const done = await run(
                  () => api.post('/auth/totp/enable', { code }),
                  'Two-step login turned on',
                )
                if (done) {
                  setSetup(null)
                  setCode('')
                }
              }}
            >
              <Field label="6-digit code">
                <Input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </Field>
              <Button type="submit" disabled={!code}>
                Turn on
              </Button>
            </form>
          </>
        ) : (
          <div>
            <Button
              variant="outline"
              onClick={async () => {
                const result = await run(() =>
                  api.post<{ secret: string; uri: string }>('/auth/totp/setup'),
                )
                if (result) setSetup(result)
              }}
            >
              Set up two-step login
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function DeleteAccount({ me, identities }: { me: Me; identities: Identity[] }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [busy, setBusy] = useState(false)

  const workspace = me.workspace.name
  const proof = me.hasPassword ? 'password' : me.totpEnabled ? 'code' : null
  const linked = identities.map((identity) => identity.provider)
  const ready = name.trim() === workspace.trim() && (proof === null || secret.length > 0)

  function reset(next: boolean) {
    setOpen(next)
    if (!next) {
      setName('')
      setSecret('')
      setError('')
      setNeedsSignIn(false)
    }
  }

  async function remove(event: FormEvent) {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    setError('')
    try {
      await api.del('/auth/account', proof ? { [proof]: secret } : {})
      queryClient.clear()
      window.location.assign('/login?deleted=1')
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Something went wrong.'
      if (message === 'recent_sign_in_required') setNeedsSignIn(true)
      else setError(message)
      setBusy(false)
    }
  }

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="text-destructive">Delete account</CardTitle>
        <CardDescription>
          Deletes your account and its workspace, {workspace}, with all its customers,
          subscriptions, invoices, templates and stored files. This can’t be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog open={open} onOpenChange={reset}>
          <AlertDialogTrigger asChild>
            <Button variant="outline" className="text-destructive">
              Delete account
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <form className="grid gap-4" onSubmit={remove}>
              {proof === 'password' && <UsernameHint email={me.email} />}
              <AlertDialogHeader>
                <AlertDialogTitle>Delete your account?</AlertDialogTitle>
                <AlertDialogDescription>
                  Everything in {workspace} is deleted for good, and you are logged out of every
                  device.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <Field label={`Type “${workspace}” to confirm`}>
                <Input
                  name="confirmWorkspace"
                  autoComplete="off"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              {proof === 'password' && (
                <Field label="Password">
                  <Input
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                  />
                </Field>
              )}
              {proof === 'code' && (
                <Field label="6-digit code from your authenticator app">
                  <Input
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                  />
                </Field>
              )}
              {proof === null && !needsSignIn && (
                <p className="text-muted-foreground text-sm">
                  You need to have logged in within the last 10 minutes. If it has been longer,
                  you’ll be asked to log in again with{' '}
                  {linked.map((p) => PROVIDER_LABEL[p]).join(' or ') || 'Google or Apple'}.
                </p>
              )}
              {needsSignIn && (
                <div className="grid gap-2">
                  <p className="text-sm">
                    For your safety, log in again, then come back to Settings → Account and delete
                    within 10 minutes.
                  </p>
                  {(linked.length ? linked : PROVIDERS).map((p) => (
                    <Button
                      key={p}
                      type="button"
                      variant="outline"
                      onClick={() =>
                        window.location.assign(oauthStartUrl(p, 'signin', '/settings/account'))
                      }
                    >
                      Log in again with {PROVIDER_LABEL[p]}
                    </Button>
                  ))}
                </div>
              )}
              <FieldError>{error}</FieldError>
              <AlertDialogFooter>
                <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
                <Button
                  type="submit"
                  disabled={!ready || busy}
                  className="bg-destructive hover:bg-destructive/90 text-white"
                >
                  Delete account
                </Button>
              </AlertDialogFooter>
            </form>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}

/** Shows the result of a Google or Apple link, which comes back as `?linked=` or `?error=`. */
function useLinkResult() {
  const [params, setParams] = useSearchParams()
  const linked = params.get('linked')
  const error = params.get('error')
  useEffect(() => {
    if (!linked && !error) return
    if (linked) {
      const label = PROVIDER_LABEL[linked as ProviderName] ?? 'Account'
      toast.success(`${label} linked`, { id: 'oauth-link' })
    } else if (error) {
      toast.error(oauthErrorMessage(error), { id: 'oauth-link' })
    }
    setParams({}, { replace: true })
  }, [linked, error, setParams])
}

export function AccountPage() {
  useLinkResult()
  const me = useApi<Me>('/auth/me')
  const identities = useApi<Identity[]>('/auth/identities')
  if (!me.data) return <Loading />
  const linked = identities.data ?? []
  return (
    <div className="grid max-w-3xl gap-6">
      <Profile me={me.data} />
      <SignInMethods me={me.data} identities={linked} />
      <Password hasPassword={me.data.hasPassword} email={me.data.email} />
      <TwoStep
        enabled={me.data.totpEnabled}
        hasPassword={me.data.hasPassword}
        email={me.data.email}
      />
      <DeleteAccount me={me.data} identities={linked} />
    </div>
  )
}
