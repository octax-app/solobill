import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'
import {
  AuthShell,
  FieldError,
  fieldErrors,
  ProviderButtons,
  useProviders,
} from '@/components/auth'
import { Field, Loading } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { PASSWORD_MIN, registerInput } from '../../shared/auth.ts'

function BackToLogin({ label = 'Back to log in' }: { label?: string }) {
  return (
    <Button asChild variant="outline">
      <Link to="/login">{label}</Link>
    </Button>
  )
}

export function RegisterPage() {
  const providers = useProviders()
  const [form, setForm] = useState({
    name: '',
    workspaceName: '',
    email: '',
    password: '',
    confirm: '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [state, setState] = useState<'form' | 'busy' | 'sent' | 'closed'>('form')

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm({ ...form, [key]: event.target.value })

  async function submit(event: FormEvent) {
    event.preventDefault()
    const parsed = registerInput.safeParse({ ...form, name: form.name || undefined })
    const next = parsed.success ? {} : fieldErrors(parsed.error)
    if (form.confirm !== form.password) next.confirm = 'The passwords don’t match'
    setErrors(next)
    if (!parsed.success || next.confirm) return
    setState('busy')
    try {
      await api.post('/auth/register', parsed.data)
      setState('sent')
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Something went wrong.'
      if (message === 'registration_closed') setState('closed')
      else {
        setErrors({ form: message })
        setState('form')
      }
    }
  }

  if (providers.isLoading) return <Loading />

  if (state === 'closed' || providers.data?.registration === false) {
    return (
      <AuthShell title="Sign-up is closed" description="New accounts can’t be created right now.">
        <BackToLogin />
      </AuthShell>
    )
  }

  if (state === 'sent') {
    return (
      <AuthShell
        title="Check your email"
        description={
          <>
            We sent a link to <span className="text-foreground font-medium">{form.email}</span>.
            Open it to verify your address, then log in.
          </>
        }
      >
        <p className="text-muted-foreground text-sm">
          Nothing there? Check your spam folder. The link works for 24 hours.
        </p>
        <BackToLogin />
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Create account" description="Set up a workspace for your business.">
      <ProviderButtons />
      <form className="grid gap-4" onSubmit={submit} noValidate>
        <Field label="Your name (optional)">
          <Input name="name" autoComplete="name" value={form.name} onChange={set('name')} />
          <FieldError>{errors.name}</FieldError>
        </Field>
        <Field label="Business name" hint="You can change it later in Settings.">
          <Input
            name="workspaceName"
            autoComplete="organization"
            value={form.workspaceName}
            onChange={set('workspaceName')}
          />
          <FieldError>{errors.workspaceName}</FieldError>
        </Field>
        <Field label="Email">
          <Input
            type="email"
            name="email"
            autoComplete="username"
            value={form.email}
            onChange={set('email')}
          />
          <FieldError>{errors.email}</FieldError>
        </Field>
        <Field label="Password" hint={`At least ${PASSWORD_MIN} characters.`}>
          <Input
            type="password"
            name="password"
            autoComplete="new-password"
            value={form.password}
            onChange={set('password')}
          />
          <FieldError>{errors.password}</FieldError>
        </Field>
        <Field label="Confirm password">
          <Input
            type="password"
            name="confirm"
            autoComplete="new-password"
            value={form.confirm}
            onChange={set('confirm')}
          />
          <FieldError>{errors.confirm}</FieldError>
        </Field>
        <FieldError>{errors.form}</FieldError>
        <Button type="submit" disabled={state === 'busy'}>
          Create account
        </Button>
      </form>
      <p className="text-muted-foreground text-center text-sm">
        Already have an account?{' '}
        <Link to="/login" className="text-foreground underline-offset-4 hover:underline">
          Log in
        </Link>
      </p>
    </AuthShell>
  )
}
