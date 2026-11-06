import { type FormEvent, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { AuthShell, FieldError, fieldErrors } from '@/components/auth'
import { Field } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { PASSWORD_MIN, resetPasswordInput } from '../../shared/auth.ts'

export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [state, setState] = useState<'form' | 'busy' | 'done' | 'failed'>(token ? 'form' : 'failed')
  const [failure, setFailure] = useState(
    token ? '' : 'This link is missing its code. Open the link from the email again.',
  )

  async function submit(event: FormEvent) {
    event.preventDefault()
    const parsed = resetPasswordInput.safeParse({ token, password })
    const next = parsed.success ? {} : fieldErrors(parsed.error)
    if (confirm !== password) next.confirm = 'The passwords don’t match'
    setErrors(next)
    if (!parsed.success || next.confirm) {
      if (next.token) {
        setFailure('This link isn’t valid. Request a new one.')
        setState('failed')
      }
      return
    }
    setState('busy')
    try {
      await api.post('/auth/reset-password', parsed.data)
      setState('done')
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'This link didn’t work.')
      setState('failed')
    }
  }

  if (state === 'done') {
    return (
      <AuthShell
        title="Password changed"
        description="Your new password is set. For safety, you’ve been logged out everywhere, including the apps."
      >
        <Button asChild>
          <Link to="/login">Log in</Link>
        </Button>
      </AuthShell>
    )
  }

  if (state === 'failed') {
    return (
      <AuthShell
        title="This link didn’t work"
        description="It may have expired or already been used. Reset links work once, for 1 hour."
      >
        <p className="text-destructive text-sm">{failure}</p>
        <Button asChild>
          <Link to="/forgot-password">Get a new link</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link to="/login">Back to log in</Link>
        </Button>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Choose a new password">
      <form className="grid gap-4" onSubmit={submit} noValidate>
        <Field label="New password" hint={`At least ${PASSWORD_MIN} characters.`}>
          <Input
            type="password"
            name="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <FieldError>{errors.password}</FieldError>
        </Field>
        <Field label="Confirm password">
          <Input
            type="password"
            name="confirm"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
          <FieldError>{errors.confirm}</FieldError>
        </Field>
        <Button type="submit" disabled={state === 'busy'}>
          Set password
        </Button>
      </form>
    </AuthShell>
  )
}
