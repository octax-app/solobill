import { type FormEvent, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  AuthShell,
  FieldError,
  oauthErrorMessage,
  ProviderButtons,
  ResendVerification,
  useProviders,
} from '@/components/auth'
import { Field } from '@/components/common'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, queryClient } from '@/lib/api'

export function LoginPage() {
  const [params] = useSearchParams()
  const providers = useProviders()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [needsCode, setNeedsCode] = useState(false)
  const [unverified, setUnverified] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const oauthError = params.get('error')
  const deleted = params.has('deleted')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.post('/auth/login', { email, password, code: code || undefined })
      await queryClient.invalidateQueries()
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Log in failed'
      if (message === 'totp_required') setNeedsCode(true)
      else if (message === 'email_unverified') setUnverified(true)
      else setError(message)
    } finally {
      setBusy(false)
    }
  }

  if (unverified) {
    return (
      <AuthShell
        title="Check your email"
        description={
          <>
            Verify <span className="text-foreground font-medium">{email}</span> before you log in.
            Open the link we emailed you.
          </>
        }
      >
        <ResendVerification initialEmail={email} />
        <Button variant="ghost" onClick={() => setUnverified(false)}>
          Back to log in
        </Button>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Octax Solobill" description="Log in to manage your services and invoices.">
      {deleted && (
        <Alert>
          <AlertDescription>Your account was deleted.</AlertDescription>
        </Alert>
      )}
      {oauthError && (
        <Alert variant="destructive">
          <AlertDescription>{oauthErrorMessage(oauthError)}</AlertDescription>
        </Alert>
      )}
      <ProviderButtons />
      <form className="grid gap-4" onSubmit={submit}>
        <Field label="Email">
          <Input
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link
              to="/forgot-password"
              className="text-muted-foreground text-xs underline-offset-4 hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {needsCode && (
          <Field label="6-digit code">
            <Input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </Field>
        )}
        <FieldError>{error}</FieldError>
        <Button type="submit" disabled={busy}>
          Log in
        </Button>
      </form>
      {providers.data?.registration && (
        <p className="text-muted-foreground text-center text-sm">
          New here?{' '}
          <Link to="/register" className="text-foreground underline-offset-4 hover:underline">
            Create account
          </Link>
        </p>
      )}
    </AuthShell>
  )
}
