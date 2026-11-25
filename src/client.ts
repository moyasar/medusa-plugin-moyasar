import { setTimeout as sleep } from "node:timers/promises"
import type {
  CreatePaymentIntentParams,
  MoyasarPayment,
  MoyasarPaymentIntent,
} from "./types"

export interface MoyasarClientConfig {
  secretKey: string
  baseUrl?: string
  timeoutMs?: number
  maxNetworkRetries?: number
  fetch?: typeof fetch
  userAgent?: string
}

export interface MoyasarApiErrorBody {
  type?: string
  message?: string
  errors?: unknown
}

export class MoyasarApiError extends Error {
  readonly status: number
  readonly type: string | undefined
  readonly errors: unknown

  constructor(status: number, body: MoyasarApiErrorBody | undefined) {
    super(body?.message ?? `Moyasar API responded with HTTP ${status}`)
    this.name = "MoyasarApiError"
    this.status = status
    this.type = body?.type
    this.errors = body?.errors
  }

  get isNotFound(): boolean {
    return this.status === 404
  }

  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500
  }
}

export class MoyasarNetworkError extends Error {
  constructor(cause: unknown) {
    super(
      `Could not reach Moyasar: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    )
    this.name = "MoyasarNetworkError"
  }
}

type Method = "GET" | "POST"

interface RequestOptions {
  body?: Record<string, unknown>
  retry?: boolean
}

const DEFAULT_BASE_URL = "https://api.moyasar.com"
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 2

export class MoyasarClient {
  private readonly baseUrl: string
  private readonly authorization: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly fetchImpl: typeof fetch
  private readonly userAgent: string

  constructor(config: MoyasarClientConfig) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.authorization = `Basic ${Buffer.from(`${config.secretKey}:`).toString("base64")}`
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = config.maxNetworkRetries ?? DEFAULT_MAX_RETRIES
    this.fetchImpl = config.fetch ?? globalThis.fetch
    this.userAgent = config.userAgent ?? "medusa-plugin-moyasar"
  }

  createPaymentIntent(
    params: CreatePaymentIntentParams
  ): Promise<MoyasarPaymentIntent> {
    return this.request("POST", "/v1/payment_intents", {
      body: { ...params },
      retry: true,
    })
  }

  retrievePaymentIntent(id: string): Promise<MoyasarPaymentIntent> {
    return this.request("GET", `/v1/payment_intents/${encodeURIComponent(id)}`)
  }

  cancelPaymentIntent(id: string): Promise<MoyasarPaymentIntent> {
    return this.request(
      "POST",
      `/v1/payment_intents/${encodeURIComponent(id)}/cancel`,
      { retry: true }
    )
  }

  retrievePayment(id: string): Promise<MoyasarPayment> {
    return this.request("GET", `/v1/payments/${encodeURIComponent(id)}`)
  }

  capturePayment(id: string, amount?: number): Promise<MoyasarPayment> {
    return this.request("POST", `/v1/payments/${encodeURIComponent(id)}/capture`, {
      body: amount === undefined ? {} : { amount },
    })
  }

  voidPayment(id: string): Promise<MoyasarPayment> {
    return this.request("POST", `/v1/payments/${encodeURIComponent(id)}/void`)
  }

  refundPayment(id: string, amount?: number): Promise<MoyasarPayment> {
    return this.request("POST", `/v1/payments/${encodeURIComponent(id)}/refund`, {
      body: amount === undefined ? {} : { amount },
    })
  }

  private async request<T>(
    method: Method,
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const retryable = method === "GET" || options.retry === true
    const attempts = retryable ? this.maxRetries + 1 : 1

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.send<T>(method, path, options.body)
      } catch (error) {
        const transient =
          error instanceof MoyasarNetworkError ||
          (error instanceof MoyasarApiError && error.isRetryable)

        if (!transient || attempt >= attempts) {
          throw error
        }

        await sleep(backoff(attempt))
      }
    }
  }

  private async send<T>(
    method: Method,
    path: string,
    body: Record<string, unknown> | undefined
  ): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.authorization,
          Accept: "application/json",
          "User-Agent": this.userAgent,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new MoyasarNetworkError(error)
    }

    const text = await response.text()
    const parsed = text ? safeJson(text) : undefined

    if (!response.ok) {
      throw new MoyasarApiError(
        response.status,
        parsed as MoyasarApiErrorBody | undefined
      )
    }

    return parsed as T
  }
}

function backoff(attempt: number): number {
  const base = 250 * 2 ** (attempt - 1)
  return base / 2 + Math.random() * (base / 2)
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { message: text.slice(0, 500) }
  }
}
