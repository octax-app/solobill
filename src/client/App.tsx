import { Navigate, Route, Routes, useLocation } from 'react-router'
import { Loading } from './components/common.tsx'
import { Layout } from './components/layout.tsx'
import { useApi } from './lib/api.ts'
import type { Me } from './lib/types.ts'
import { AccountPage } from './pages/account.tsx'
import { CustomerDetailPage } from './pages/customer-detail.tsx'
import { CustomersPage } from './pages/customers.tsx'
import { FontsPage } from './pages/fonts.tsx'
import { ForgotPasswordPage } from './pages/forgot-password.tsx'
import { InvoiceDetailPage } from './pages/invoice-detail.tsx'
import { InvoiceEditorPage } from './pages/invoice-editor.tsx'
import { InvoicesPage } from './pages/invoices.tsx'
import { LoginPage } from './pages/login.tsx'
import { OriginalFormPage } from './pages/original-form.tsx'
import { OriginalsPage } from './pages/originals.tsx'
import { OverviewPage } from './pages/overview.tsx'
import { ProvidersPage } from './pages/providers.tsx'
import { RegisterPage } from './pages/register.tsx'
import { ResetPasswordPage } from './pages/reset-password.tsx'
import { ServicesPage } from './pages/services.tsx'
import { SettingsLayout, SettingsPage } from './pages/settings.tsx'
import { SubscriptionsPage } from './pages/subscriptions.tsx'
import { TemplateDetailPage } from './pages/template-detail.tsx'
import { TemplatesPage } from './pages/templates.tsx'
import { VerifyEmailPage } from './pages/verify-email.tsx'

/** Pages for someone who is not signed in. Anything else goes to the login page. */
function SignedOut() {
  const location = useLocation()
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route path="register" element={<RegisterPage />} />
      <Route path="verify-email" element={<VerifyEmailPage signedIn={false} />} />
      <Route path="forgot-password" element={<ForgotPasswordPage />} />
      <Route path="reset-password" element={<ResetPasswordPage />} />
      <Route path="*" element={<Navigate to="/login" replace state={{ from: location }} />} />
    </Routes>
  )
}

/** After logging in on /login, go back to the page that sent the user there. */
function AfterLogin() {
  const location = useLocation()
  const from = (location.state as { from?: { pathname: string; search: string } } | null)?.from
  return <Navigate to={from ? `${from.pathname}${from.search}` : '/'} replace />
}

export function App() {
  const me = useApi<Me>('/auth/me')
  if (me.isLoading) return <Loading />
  if (!me.data) return <SignedOut />
  return (
    <Routes>
      <Route path="verify-email" element={<VerifyEmailPage signedIn />} />
      <Route path="login" element={<AfterLogin />} />
      <Route path="register" element={<Navigate to="/" replace />} />
      <Route path="forgot-password" element={<Navigate to="/" replace />} />
      <Route path="reset-password" element={<Navigate to="/" replace />} />
      <Route element={<Layout email={me.data.email} workspace={me.data.workspace.name} />}>
        <Route index element={<OverviewPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="customers/:id" element={<CustomerDetailPage />} />
        <Route path="subscriptions" element={<SubscriptionsPage />} />
        <Route path="invoices" element={<InvoicesPage type="invoice" />} />
        <Route path="invoices/new" element={<InvoiceEditorPage type="invoice" />} />
        <Route path="invoices/:id" element={<InvoiceDetailPage />} />
        <Route path="invoices/:id/edit" element={<InvoiceEditorPage type="invoice" />} />
        <Route path="proformas" element={<InvoicesPage type="proforma" />} />
        <Route path="proformas/new" element={<InvoiceEditorPage type="proforma" />} />
        <Route path="originals" element={<OriginalsPage />} />
        <Route path="originals/new" element={<OriginalFormPage />} />
        <Route path="originals/:id" element={<OriginalFormPage />} />
        <Route path="providers" element={<ProvidersPage />} />
        <Route path="services" element={<ServicesPage />} />
        <Route path="templates" element={<TemplatesPage />} />
        <Route path="templates/:id" element={<TemplateDetailPage />} />
        <Route path="fonts" element={<FontsPage />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<SettingsPage />} />
          <Route path="account" element={<AccountPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
