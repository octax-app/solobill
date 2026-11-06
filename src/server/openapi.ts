import { z } from 'zod'
import * as res from '../shared/api-responses.ts'
import {
  changePasswordInput,
  deleteAccountInput,
  emailInput,
  oauthLinkInput,
  oauthTokenInput,
  registerInput,
  totpDisableInput,
  workspaceInput,
} from '../shared/auth.ts'
import {
  customerPaymentInput,
  deviceInput,
  invoiceInput,
  originalInvoiceInput,
  paidInput,
  paymentInput,
} from '../shared/schemas.ts'

type Schema = z.ZodType
type Method = 'get' | 'post' | 'put' | 'delete'

interface Route {
  method: Method
  path: string
  summary: string
  /** A response schema, wrapped in an array when the route returns a list. */
  response?: Schema | [Schema]
  /** Set when the route returns PDF bytes instead of JSON. */
  pdf?: boolean
  request?: Schema
  upload?: boolean
  query?: string[]
  status?: number
  public?: boolean
}

const credentials = z.object({
  email: z.string(),
  password: z.string(),
  code: z.string().optional(),
  name: z.string().min(1).max(80),
})

const responses: Record<string, Schema> = {
  ApiToken: res.apiTokenResponse,
  AuthProviders: res.authProvidersResponse,
  Identity: res.identityResponse,
  Workspace: res.workspaceResponse,
  TotpState: res.totpStateResponse,
  Customer: res.customerResponse,
  CustomerPayment: res.customerPaymentResponse,
  CustomerSummary: res.customerSummaryResponse,
  Error: res.errorResponse,
  FxRate: res.fxRateResponse,
  Invoice: res.invoiceResponse,
  InvoiceFull: res.invoiceFullResponse,
  InvoiceRow: res.invoiceRowResponse,
  Me: res.meResponse,
  Ok: res.okResponse,
  OriginalFull: res.originalFullResponse,
  OriginalRow: res.originalRowResponse,
  Overview: res.overviewResponse,
  Provider: res.providerResponse,
  Reminder: res.reminderResponse,
  ResolvedTemplate: res.resolvedTemplateResponse,
  Service: res.serviceResponse,
  Settings: res.settingsResponse,
  Subscription: res.subscriptionResponse,
  Template: res.templateResponse,
}

const requests: Record<string, Schema> = {
  CustomerPaymentInput: customerPaymentInput,
  DeviceInput: deviceInput,
  InvoiceInput: invoiceInput,
  OriginalInvoiceInput: originalInvoiceInput,
  PaidInput: paidInput,
  PaymentInput: paymentInput,
  TokenRequest: credentials,
  RegisterInput: registerInput,
  EmailInput: emailInput,
  OAuthTokenInput: oauthTokenInput,
  OAuthLinkInput: oauthLinkInput,
  ChangePasswordInput: changePasswordInput,
  DeleteAccountInput: deleteAccountInput,
  TotpDisableInput: totpDisableInput,
  WorkspaceInput: workspaceInput,
}

const routes: Route[] = [
  {
    method: 'post',
    path: '/auth/token',
    summary: 'Exchange credentials for a bearer token. A 401 of "totp_required" asks for the code.',
    request: credentials,
    response: res.apiTokenResponse,
    status: 201,
    public: true,
  },
  {
    method: 'get',
    path: '/auth/providers',
    summary: 'Which sign-in methods and whether sign-up are available',
    response: res.authProvidersResponse,
    public: true,
  },
  {
    method: 'post',
    path: '/auth/register',
    summary:
      'Create an account and its workspace, and email a verification link. Always 202, even for a taken email. 403 "registration_closed" when sign-up is off.',
    request: registerInput,
    response: res.okResponse,
    status: 202,
    public: true,
  },
  {
    method: 'post',
    path: '/auth/resend-verification',
    summary: 'Email the verification link again. Always 202.',
    request: emailInput,
    response: res.okResponse,
    status: 202,
    public: true,
  },
  {
    method: 'post',
    path: '/auth/forgot-password',
    summary: 'Email a password reset link. Always 202.',
    request: emailInput,
    response: res.okResponse,
    status: 202,
    public: true,
  },
  {
    method: 'post',
    path: '/auth/oauth/{provider}/token',
    summary:
      'Sign in with a Google or Apple ID token from a native app, creating the account the first time. provider is google or apple.',
    request: oauthTokenInput,
    response: res.apiTokenResponse,
    status: 201,
    public: true,
  },
  { method: 'get', path: '/auth/me', summary: 'The signed-in user', response: res.meResponse },
  {
    method: 'get',
    path: '/auth/identities',
    summary: 'Linked Google and Apple accounts',
    response: [res.identityResponse],
  },
  {
    method: 'post',
    path: '/auth/oauth/{provider}/link',
    summary: 'Link a Google or Apple account to the signed-in user, from a native sign-in',
    request: oauthLinkInput,
    response: res.identityResponse,
    status: 201,
  },
  {
    method: 'delete',
    path: '/auth/identities/{provider}',
    summary: 'Unlink a Google or Apple account. 409 when it is the last way to sign in.',
    response: res.okResponse,
  },
  {
    method: 'post',
    path: '/auth/password',
    summary: 'Set or change the password. currentPassword is required when one is set.',
    request: changePasswordInput,
    response: res.okResponse,
  },
  {
    method: 'post',
    path: '/auth/totp/disable',
    summary: 'Turn off two-step login, with the password or, without one, a current code',
    request: totpDisableInput,
    response: res.totpStateResponse,
  },
  {
    method: 'delete',
    path: '/auth/account',
    summary:
      'Delete the account and its workspace. Needs the password, a TOTP code, or, without either, a sign-in in the last 10 minutes (403 "recent_sign_in_required").',
    request: deleteAccountInput,
    response: res.okResponse,
  },
  {
    method: 'put',
    path: '/workspace',
    summary: 'Rename the workspace',
    request: workspaceInput,
    response: res.workspaceResponse,
  },
  {
    method: 'delete',
    path: '/auth/tokens/{id}',
    summary: 'Revoke a bearer token',
    response: res.okResponse,
  },
  { method: 'get', path: '/settings', summary: 'App settings', response: res.settingsResponse },
  {
    method: 'get',
    path: '/overview',
    summary: 'Profit, pending invoices and renewals for a period',
    query: ['from', 'to'],
    response: res.overviewResponse,
  },
  {
    method: 'get',
    path: '/customers',
    summary: 'List and search customers',
    query: ['q', 'status'],
    response: [res.customerResponse],
  },
  { method: 'get', path: '/customers/{id}', summary: 'A customer', response: res.customerResponse },
  {
    method: 'get',
    path: '/customers/{id}/summary',
    summary: 'Totals for one customer',
    response: res.customerSummaryResponse,
  },
  {
    method: 'post',
    path: '/customers/{id}/payments',
    summary: "Spread one payment over the customer's open invoices, oldest first",
    request: customerPaymentInput,
    response: res.customerPaymentResponse,
    status: 201,
  },
  {
    method: 'get',
    path: '/providers',
    summary: 'List providers',
    response: [res.providerResponse],
  },
  {
    method: 'get',
    path: '/services',
    summary: 'List services',
    query: ['providerId'],
    response: [res.serviceResponse],
  },
  {
    method: 'get',
    path: '/subscriptions',
    summary: 'List subscriptions',
    query: ['customerId'],
    response: [res.subscriptionResponse],
  },
  {
    method: 'get',
    path: '/templates',
    summary: 'List templates',
    response: [res.templateResponse],
  },
  {
    method: 'get',
    path: '/fx-rate',
    summary: 'The last exchange rate used for a currency',
    query: ['currency'],
    response: res.fxRateResponse,
  },
  {
    method: 'get',
    path: '/resolve-template',
    summary: 'The template that applies to a service or provider',
    query: ['serviceId', 'providerId'],
    response: res.resolvedTemplateResponse,
  },
  {
    method: 'get',
    path: '/invoices',
    summary: 'List invoices and proformas',
    query: ['type', 'status', 'customerId'],
    response: [res.invoiceRowResponse],
  },
  {
    method: 'post',
    path: '/invoices',
    summary: 'Create a draft',
    request: invoiceInput,
    response: res.invoiceFullResponse,
    status: 201,
  },
  {
    method: 'get',
    path: '/invoices/{id}',
    summary: 'A document with its lines and payments',
    response: res.invoiceFullResponse,
  },
  {
    method: 'put',
    path: '/invoices/{id}',
    summary: 'Replace a draft',
    request: invoiceInput,
    response: res.invoiceFullResponse,
  },
  {
    method: 'delete',
    path: '/invoices/{id}',
    summary: 'Delete a manual draft',
    response: res.okResponse,
  },
  { method: 'get', path: '/invoices/{id}/pdf', summary: 'The document as a PDF', pdf: true },
  {
    method: 'post',
    path: '/invoices/{id}/issue',
    summary: 'Issue a draft',
    response: res.invoiceFullResponse,
  },
  {
    method: 'post',
    path: '/invoices/{id}/void',
    summary: 'Void a document, or discard a renewal draft',
    response: res.invoiceResponse,
  },
  {
    method: 'post',
    path: '/invoices/{id}/reverse',
    summary: 'Send an unpaid issued document back to draft and delete its stored PDF',
    response: res.invoiceFullResponse,
  },
  {
    method: 'post',
    path: '/invoices/{id}/undo-payments',
    summary: 'Remove every payment and discount on a paid invoice, returning it to issued',
    response: res.invoiceFullResponse,
  },
  {
    method: 'post',
    path: '/invoices/{id}/duplicate',
    summary: 'Copy a document into a new draft',
    response: res.invoiceFullResponse,
  },
  {
    method: 'post',
    path: '/invoices/{id}/paid',
    summary: 'Mark an issued invoice as paid, recording a payment of what is due',
    request: paidInput,
    response: res.invoiceResponse,
  },
  {
    method: 'post',
    path: '/invoices/{id}/unpaid',
    summary: 'Undo mark as paid, by removing the last payment entered and its group',
    response: res.invoiceResponse,
  },
  {
    method: 'post',
    path: '/invoices/{id}/payments',
    summary: 'Add a payment or a discount to an issued invoice',
    request: paymentInput,
    response: res.invoiceFullResponse,
  },
  {
    method: 'delete',
    path: '/payments/{id}',
    summary: 'Remove a payment or discount, and every row of its customer payment',
    response: res.okResponse,
  },
  {
    method: 'get',
    path: '/originals',
    summary: 'List original invoices',
    response: [res.originalRowResponse],
  },
  {
    method: 'post',
    path: '/originals',
    summary: 'Add an original invoice',
    request: originalInvoiceInput,
    response: res.originalFullResponse,
    status: 201,
  },
  {
    method: 'get',
    path: '/originals/{id}',
    summary: 'An original invoice and its lines',
    response: res.originalFullResponse,
  },
  {
    method: 'post',
    path: '/originals/{id}/pdf',
    summary: 'Attach a PDF to an original invoice',
    upload: true,
    response: res.originalFullResponse,
  },
  {
    method: 'post',
    path: '/originals/{id}/paid',
    summary: 'Mark an original invoice as paid',
    request: paidInput,
    response: res.originalFullResponse,
  },
  {
    method: 'post',
    path: '/originals/{id}/unpaid',
    summary: 'Undo mark as paid',
    response: res.originalFullResponse,
  },
  {
    method: 'post',
    path: '/devices',
    summary: 'Register this phone for reminder notifications. Bearer tokens only.',
    request: deviceInput,
    response: res.okResponse,
  },
  {
    method: 'get',
    path: '/reminders',
    summary: 'Unread reminders',
    response: [res.reminderResponse],
  },
  {
    method: 'post',
    path: '/reminders/{id}/read',
    summary: 'Mark a reminder as read',
    response: res.okResponse,
  },
  { method: 'get', path: '/files/{key}', summary: 'A stored file, by its internal key', pdf: true },
]

function jsonSchema(schema: Schema, io: 'input' | 'output') {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'any' })
  return rest
}

const nameOf = (schema: Schema, table: Record<string, Schema>) => {
  const entry = Object.entries(table).find(([, value]) => value === schema)
  if (!entry) throw new Error('A route uses a schema that is not named in openapi.ts')
  return entry[0]
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

function responseContent(route: Route) {
  if (route.pdf) {
    return { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }
  }
  const { response } = route
  if (!response) throw new Error(`${route.path} has no response schema`)
  const schema = Array.isArray(response)
    ? { type: 'array', items: ref(nameOf(response[0], responses)) }
    : ref(nameOf(response, responses))
  return { 'application/json': { schema } }
}

function operation(route: Route) {
  const pathParams = [...route.path.matchAll(/{(\w+)}/g)].map(([, name]) => ({
    name,
    in: 'path',
    required: true,
    schema: name === 'key' ? { type: 'string' } : { type: 'integer' },
  }))
  const queryParams = (route.query ?? []).map((name) => ({
    name,
    in: 'query',
    schema: { type: 'string' },
  }))
  const parameters = [...pathParams, ...queryParams]
  return {
    summary: route.summary,
    ...(route.public ? { security: [] } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(route.request
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref(nameOf(route.request, requests)) } },
          },
        }
      : {}),
    ...(route.upload
      ? {
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: { file: { type: 'string', format: 'binary' } },
                },
              },
            },
          },
        }
      : {}),
    responses: {
      [route.status ?? 200]: { description: 'Success', content: responseContent(route) },
      default: {
        description: 'Failure',
        content: { 'application/json': { schema: ref('Error') } },
      },
    },
  }
}

/** Documents the `/api/v1` routes the iOS app uses. The web client is not covered. */
export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const route of routes) {
    paths[route.path] ??= {}
    paths[route.path][route.method] = operation(route)
  }
  const schemas = {
    ...Object.fromEntries(
      Object.entries(responses).map(([name, schema]) => [name, jsonSchema(schema, 'output')]),
    ),
    ...Object.fromEntries(
      Object.entries(requests).map(([name, schema]) => [name, jsonSchema(schema, 'input')]),
    ),
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Octax Solobill API',
      version: '1.0.0',
      description:
        'Amounts and quantities are integers scaled by 10,000. Exchange rates are integers ' +
        'scaled by 100,000,000. Percentages are integers scaled by 10,000.',
    },
    servers: [{ url: '/api/v1' }],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas,
    },
  }
}
