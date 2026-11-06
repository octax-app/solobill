import { type FormEvent, type ReactNode, useState } from 'react'
import type { z } from 'zod'
import { Field } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { api, oauthStartUrl, useApi } from '@/lib/api'
import type { AuthProviders } from '@/lib/types'

export const PROVIDER_LABEL = { google: 'Google', apple: 'Apple' } as const

/** Codes the OAuth callbacks put in `?error=` when they redirect back to the app. */
const OAUTH_ERRORS: Record<string, string> = {
  oauth_failed: 'Signing in with Google or Apple didn’t work. Try again.',
  registration_closed: 'There is no account for that address, and sign-up is closed right now.',
  already_linked: 'That Google or Apple account is already linked to a different account.',
  email_not_verified:
    'That Google account’s email address isn’t verified, so it can’t be used to sign in.',
}

export function oauthErrorMessage(code: string) {
  return OAUTH_ERRORS[code] ?? 'Signing in didn’t work. Try again.'
}

export function useProviders() {
  return useApi<AuthProviders>('/auth/providers')
}

/** First message for each top-level field, from a failed `safeParse`. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '')
    errors[key] ??= issue.message
  }
  return errors
}

export function AuthShell({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="bg-muted flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="grid gap-4">{children}</CardContent>
      </Card>
    </div>
  )
}

export function FieldError({ children }: { children?: string }) {
  if (!children) return null
  return <p className="text-destructive text-sm">{children}</p>
}

/** "Continue with Google" and "Continue with Apple", for the providers the server has set up. */
export function ProviderButtons() {
  const providers = useProviders()
  const enabled = (['google', 'apple'] as const).filter((name) => providers.data?.[name])
  if (enabled.length === 0) return null
  return (
    <>
      <div className="grid gap-2">
        {enabled.map((name) => (
          <Button
            key={name}
            type="button"
            variant="outline"
            onClick={() => window.location.assign(oauthStartUrl(name, 'signin'))}
          >
            Continue with {PROVIDER_LABEL[name]}
          </Button>
        ))}
      </div>
      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        <Separator className="flex-1" />
        or
        <Separator className="flex-1" />
      </div>
    </>
  )
}

/** Sends the verification link again. The server always answers 202. */
export function ResendVerification({ initialEmail = '' }: { initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail)
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle')
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setState('busy')
    setError('')
    try {
      await api.post('/auth/resend-verification', { email })
      setState('sent')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Something went wrong. Try again.')
      setState('idle')
    }
  }

  if (state === 'sent') {
    return (
      <p className="text-sm">
        If <span className="font-medium">{email}</span> needs verifying, a new link is on its way.
        Check your inbox and spam folder.
      </p>
    )
  }
  return (
    <form className="grid gap-3" onSubmit={submit}>
      {!initialEmail && (
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
      )}
      <FieldError>{error}</FieldError>
      <Button type="submit" variant="outline" disabled={state === 'busy'}>
        Resend email
      </Button>
    </form>
  )
}
