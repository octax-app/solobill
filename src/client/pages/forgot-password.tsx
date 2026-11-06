import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'
import { AuthShell, FieldError } from '@/components/auth'
import { Field } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'form' | 'busy' | 'sent'>('form')
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setState('busy')
    setError('')
    try {
      await api.post('/auth/forgot-password', { email })
      setState('sent')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Something went wrong. Try again.')
      setState('form')
    }
  }

  const back = (
    <Button asChild variant={state === 'sent' ? 'outline' : 'ghost'}>
      <Link to="/login">Back to log in</Link>
    </Button>
  )

  if (state === 'sent') {
    return (
      <AuthShell
        title="Check your email"
        description={
          <>
            If there is an account for <span className="text-foreground font-medium">{email}</span>,
            we sent it a link to reset the password.
          </>
        }
      >
        <p className="text-muted-foreground text-sm">
          The link works once, for 1 hour. Nothing there? Check your spam folder.
        </p>
        {back}
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="Forgot password"
      description="Enter your email and we’ll send you a link to choose a new password."
    >
      <form className="grid gap-4" onSubmit={submit}>
        <Field label="Email">
          <Input
            type="email"
            name="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <FieldError>{error}</FieldError>
        <Button type="submit" disabled={state === 'busy'}>
          Send reset link
        </Button>
      </form>
      {back}
    </AuthShell>
  )
}
