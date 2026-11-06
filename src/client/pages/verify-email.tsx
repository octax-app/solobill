import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { AuthShell, ResendVerification } from '@/components/auth'
import { Loading } from '@/components/common'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

/** Opened from the verification email. Works whether or not someone is signed in. */
export function VerifyEmailPage({ signedIn }: { signedIn: boolean }) {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [result, setResult] = useState<{ ok: true } | { error: string } | null>(
    token ? null : { error: 'This link is missing its code. Open the link from the email again.' },
  )
  // The token works once, so StrictMode's second effect run must not send it again.
  const sent = useRef(false)

  useEffect(() => {
    if (!token || sent.current) return
    sent.current = true
    api
      .post('/auth/verify-email', { token })
      .then(() => setResult({ ok: true }))
      .catch((failure) =>
        setResult({
          error: failure instanceof Error ? failure.message : 'This link didn’t work.',
        }),
      )
  }, [token])

  if (!result) return <Loading />

  if ('ok' in result) {
    return (
      <AuthShell title="Email verified" description="Your email address is verified.">
        <Button asChild>
          {signedIn ? <Link to="/">Continue</Link> : <Link to="/login">Log in</Link>}
        </Button>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="This link didn’t work"
      description="It may have expired or already been used. Links work once, for 24 hours."
    >
      <p className="text-destructive text-sm">{result.error}</p>
      <p className="text-sm">Enter your email to get a new link.</p>
      <ResendVerification />
      <Button asChild variant="ghost">
        {signedIn ? <Link to="/">Back to the app</Link> : <Link to="/login">Back to log in</Link>}
      </Button>
    </AuthShell>
  )
}
