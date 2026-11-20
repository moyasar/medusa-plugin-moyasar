import type { MoyasarPayment, MoyasarPaymentIntent } from "../types"

type Handler = (body: Record<string, unknown> | undefined) => {
  status: number
  body?: unknown
}

export interface RecordedCall {
  method: string
  path: string
  body: Record<string, unknown> | undefined
  headers: Record<string, string>
}

export class FakeMoyasar {
  readonly calls: RecordedCall[] = []
  private readonly routes = new Map<string, Handler[]>()

  on(method: string, path: string, handler: Handler): this {
    const key = `${method} ${path}`
    this.routes.set(key, [...(this.routes.get(key) ?? []), handler])
    return this
  }

  reply(method: string, path: string, status: number, body?: unknown): this {
    return this.on(method, path, () => ({ status, body }))
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>)
    )
    this.calls.push({ method, path: url.pathname, body, headers })

    const key = `${method} ${url.pathname}`
    const queue = this.routes.get(key)
    if (!queue?.length) {
      return new Response(JSON.stringify({ type: "record_not_found", message: "Not found" }), {
        status: 404,
      })
    }

    const handler = queue.length > 1 ? queue.shift()! : queue[0]!
    const result = handler(body)
    return new Response(result.body === undefined ? "" : JSON.stringify(result.body), {
      status: result.status,
    })
  }
}

export function intent(overrides: Partial<MoyasarPaymentIntent> = {}): MoyasarPaymentIntent {
  return {
    id: "pi_1",
    amount: 10000,
    currency: "SAR",
    description: "Medusa order",
    callback_url: "https://shop.example/checkout/moyasar",
    status: "created",
    client_secret: "pi_secret_abc",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    fulfilled_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

export function payment(overrides: Partial<MoyasarPayment> = {}): MoyasarPayment {
  return {
    id: "pay_1",
    status: "paid",
    amount: 10000,
    currency: "SAR",
    refunded: 0,
    captured: 0,
    created_at: new Date().toISOString(),
    metadata: { medusa_session_id: "payses_1" },
    source: { type: "creditcard", company: "mada", message: "APPROVED" },
    ...overrides,
  }
}
