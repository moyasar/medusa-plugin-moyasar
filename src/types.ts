export type MoyasarPaymentMethod =
  | "creditcard"
  | "applepay"
  | "samsungpay"
  | "stcpay"

export interface MoyasarOptions {
  secretKey: string
  publishableKey: string
  webhookSecret?: string
  callbackUrl?: string
  capture?: boolean
  methods?: MoyasarPaymentMethod[]
  paymentDescription?: string
  apiBaseUrl?: string
  timeoutMs?: number
  maxNetworkRetries?: number
}

export type MoyasarPaymentStatus =
  | "initiated"
  | "pending"
  | "paid"
  | "authorized"
  | "captured"
  | "failed"
  | "voided"
  | "refunded"
  | "verified"
  | "expired"

export interface MoyasarPaymentSource {
  type: string
  company?: string | null
  name?: string | null
  number?: string | null
  message?: string | null
  transaction_url?: string | null
  gateway_id?: string | null
  reference_number?: string | null
  [key: string]: unknown
}

export interface MoyasarPayment {
  id: string
  status: MoyasarPaymentStatus
  amount: number
  fee?: number
  currency: string
  refunded: number
  refunded_at?: string | null
  captured: number
  captured_at?: string | null
  voided_at?: string | null
  description?: string | null
  callback_url?: string | null
  created_at: string
  updated_at?: string
  metadata?: Record<string, string> | null
  source: MoyasarPaymentSource
}

export type MoyasarIntentStatus = "created" | "fulfilled" | "canceled"

export interface MoyasarPaymentIntent {
  id: string
  amount: number
  currency: string
  description?: string | null
  callback_url?: string | null
  status: MoyasarIntentStatus
  client_secret: string
  expires_at: string
  fulfilled_at?: string | null
  created_at: string
}

export interface CreatePaymentIntentParams {
  amount: number
  currency: string
  description?: string
  callback_url?: string
}

export type MoyasarWebhookEventType =
  | "payment_paid"
  | "payment_failed"
  | "payment_faild"
  | "payment_authorized"
  | "payment_captured"
  | "payment_voided"
  | "payment_refunded"
  | "payment_verified"
  | "payment_expired"
  | "webhook_verification"
  | (string & {})

export interface MoyasarWebhookEvent {
  id: string
  type: MoyasarWebhookEventType
  created_at: string
  secret_token: string
  account_name?: string
  live: boolean
  data: MoyasarPayment
}

export interface MoyasarSessionData extends Record<string, unknown> {
  intent_id: string
  client_secret: string
  payment_id: string
  session_id?: string
  amount: number
  currency: string
  description: string
  callback_url?: string
  publishable_api_key: string
  methods: MoyasarPaymentMethod[]
  manual: boolean
  metadata: Record<string, string>
  expires_at: string
  status?: MoyasarPaymentStatus
  payment?: MoyasarPayment
}
