import { MedusaError } from "@medusajs/framework/utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MoyasarProviderService } from "./service"
import { FakeMoyasar, intent, payment } from "./test/fake-moyasar"
import type { MoyasarOptions, MoyasarSessionData } from "./types"

const OPTIONS: MoyasarOptions = {
  secretKey: "sk_test_secret",
  publishableKey: "pk_test_public",
  webhookSecret: "moyasar-webhook-secret",
  callbackUrl: "https://shop.example/checkout/moyasar",
  maxNetworkRetries: 0,
}

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }

let fake: FakeMoyasar
let provider: MoyasarProviderService

function build(options: Partial<MoyasarOptions> = {}) {
  return new MoyasarProviderService({ logger: logger as never }, { ...OPTIONS, ...options })
}

async function initiate(amount = 100, currency = "sar"): Promise<MoyasarSessionData> {
  const result = await provider.initiatePayment({
    amount,
    currency_code: currency,
    data: { session_id: "payses_1" },
    context: { customer: { id: "cus_1", email: "shopper@example.com" } },
  })
  return result.data as MoyasarSessionData
}

beforeEach(() => {
  vi.clearAllMocks()
  fake = new FakeMoyasar()
  vi.stubGlobal("fetch", fake.fetch)
  fake.on("POST", "/v1/payment_intents", (body) => ({
    status: 201,
    body: intent({
      amount: body!.amount as number,
      currency: body!.currency as string,
      description: body!.description as string,
    }),
  }))
  provider = build()
})

describe("validateOptions", () => {
  it("accepts a valid configuration", () => {
    expect(() => MoyasarProviderService.validateOptions({ ...OPTIONS })).not.toThrow()
  })

  it.each([
    [{ secretKey: undefined }, /secretKey/],
    [{ secretKey: "pk_test_x" }, /secretKey/],
    [{ publishableKey: "sk_test_x" }, /publishableKey/],
    [{ secretKey: "sk_live_x" }, /both be test keys or both be live/],
    [{ methods: [] }, /methods/],
    [{ methods: ["paypal"] }, /methods/],
    [{ callbackUrl: "not a url" }, /callbackUrl/],
  ])("rejects %o", (override, message) => {
    expect(() => MoyasarProviderService.validateOptions({ ...OPTIONS, ...override })).toThrow(
      message
    )
  })

  it("warns when webhooks are not configured", () => {
    build({ webhookSecret: undefined })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("webhookSecret"))
  })
})

describe("initiatePayment", () => {
  it("creates a payment intent for the server-side amount", async () => {
    const result = await provider.initiatePayment({
      amount: 115.5,
      currency_code: "sar",
      data: { session_id: "payses_1" },
      context: { customer: { id: "cus_1", email: "shopper@example.com" } },
    })

    expect(fake.calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/payment_intents",
      body: {
        amount: 11550,
        currency: "SAR",
        description: "Medusa order (payses_1)",
        callback_url: OPTIONS.callbackUrl,
      },
    })
    expect(result.id).toBe("pi_1")
    expect(result.status).toBe("pending")
    expect(result.data).toMatchObject({
      intent_id: "pi_1",
      client_secret: "pi_secret_abc",
      amount: 11550,
      currency: "SAR",
      publishable_api_key: "pk_test_public",
      methods: ["creditcard", "applepay", "stcpay"],
      manual: false,
      metadata: { medusa_session_id: "payses_1", medusa_customer_id: "cus_1" },
    })
    expect(result.data!.payment_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it("never exposes the secret key to the storefront", async () => {
    const session = await initiate()
    expect(JSON.stringify(session)).not.toContain(OPTIONS.secretKey)
  })

  it("asks the storefront for manual capture when auto-capture is off", async () => {
    provider = build({ capture: false })
    expect((await initiate()).manual).toBe(true)
  })

  it("lets the storefront choose its return URL", async () => {
    await provider.initiatePayment({
      amount: 10,
      currency_code: "sar",
      data: { session_id: "payses_1", callback_url: "https://shop.example/sa/checkout?step=review" },
    })
    expect(fake.calls[0]!.body!.callback_url).toBe("https://shop.example/sa/checkout?step=review")
  })

  it("rejects a non-http return URL", async () => {
    await expect(
      provider.initiatePayment({
        amount: 10,
        currency_code: "sar",
        data: { callback_url: "javascript:alert(1)" },
      })
    ).rejects.toThrow(/callback_url/)
  })

  it("surfaces Moyasar validation errors", async () => {
    fake = new FakeMoyasar().reply("POST", "/v1/payment_intents", 400, {
      type: "validation_error",
      message: "Currency is not supported",
    })
    vi.stubGlobal("fetch", fake.fetch)
    provider = build()

    const error = await initiate(10, "eur").catch((e) => e)
    expect(error).toBeInstanceOf(MedusaError)
    expect(error.type).toBe(MedusaError.Types.NOT_ALLOWED)
    expect(error.message).toMatch(/validation_error.*Currency is not supported/)
  })
})

describe("authorizePayment", () => {
  it.each([
    ["paid", "captured"],
    ["authorized", "authorized"],
    ["captured", "captured"],
    ["initiated", "requires_more"],
    ["failed", "error"],
    ["voided", "canceled"],
  ] as const)("maps a %s payment to %s", async (moyasarStatus, medusaStatus) => {
    const session = await initiate()
    fake.reply("GET", `/v1/payments/${session.payment_id}`, 200, payment({
      id: session.payment_id,
      status: moyasarStatus,
    }))

    const result = await provider.authorizePayment({ data: session })

    expect(result.status).toBe(medusaStatus)
    expect(result.data).toMatchObject({ status: moyasarStatus, payment: { id: session.payment_id } })
  })

  it("waits for the shopper while no payment exists", async () => {
    const session = await initiate()
    expect((await provider.authorizePayment({ data: session })).status).toBe("requires_more")
  })

  it("fails once the intent has expired without a payment", async () => {
    const session = await initiate()
    const expired = { ...session, expires_at: new Date(Date.now() - 1000).toISOString() }
    expect((await provider.authorizePayment({ data: expired })).status).toBe("error")
  })

  it("refuses a paid payment for a different amount", async () => {
    const session = await initiate()
    fake.reply("GET", `/v1/payments/${session.payment_id}`, 200, payment({
      id: session.payment_id,
      amount: 100,
    }))

    const result = await provider.authorizePayment({ data: session })

    expect(result.status).toBe("error")
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Refusing to authorize"))
  })

  it("refuses a paid payment in a different currency", async () => {
    const session = await initiate()
    fake.reply("GET", `/v1/payments/${session.payment_id}`, 200, payment({
      id: session.payment_id,
      currency: "USD",
    }))

    expect((await provider.authorizePayment({ data: session })).status).toBe("error")
  })

  it("rejects sessions without Moyasar data", async () => {
    await expect(provider.authorizePayment({ data: {} })).rejects.toThrow(/Initiate the session again/)
  })
})

describe("updatePayment", () => {
  it("keeps the intent when nothing changed", async () => {
    const session = await initiate()
    fake.calls.length = 0

    const result = await provider.updatePayment({ amount: 100, currency_code: "sar", data: session })

    expect(result.data).toEqual(session)
    expect(fake.calls).toHaveLength(0)
  })

  it("replaces the intent when the cart total changes", async () => {
    const session = await initiate()
    fake.reply("POST", "/v1/payment_intents/pi_1/cancel", 200, intent({ status: "canceled" }))

    const result = await provider.updatePayment({ amount: 120, currency_code: "sar", data: session })

    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/payment_intents",
      `GET /v1/payments/${session.payment_id}`,
      "POST /v1/payment_intents/pi_1/cancel",
      "POST /v1/payment_intents",
    ])
    expect(result.data).toMatchObject({ amount: 12000, session_id: "payses_1" })
    expect(result.data!.payment_id).not.toBe(session.payment_id)
  })

  it("replaces an intent that is about to expire", async () => {
    const session = await initiate()
    const stale = { ...session, expires_at: new Date(Date.now() + 60_000).toISOString() }

    const result = await provider.updatePayment({ amount: 100, currency_code: "sar", data: stale })

    expect(result.data!.payment_id).not.toBe(session.payment_id)
  })

  it("gives the shopper a fresh intent after a declined card", async () => {
    const session = await initiate()
    fake.reply("GET", `/v1/payments/${session.payment_id}`, 200, payment({
      id: session.payment_id,
      status: "failed",
    }))

    const result = await provider.updatePayment({ amount: 120, currency_code: "sar", data: session })

    expect(result.data!.payment_id).not.toBe(session.payment_id)
  })

  it("refuses to change the amount after the shopper paid", async () => {
    const session = await initiate()
    fake.reply("GET", `/v1/payments/${session.payment_id}`, 200, payment({ id: session.payment_id }))

    await expect(
      provider.updatePayment({ amount: 120, currency_code: "sar", data: session })
    ).rejects.toThrow(/amount can no longer change/)
  })
})

describe("capturePayment", () => {
  it("captures an authorized payment", async () => {
    const session = await initiate()
    fake
      .reply("GET", `/v1/payments/${session.payment_id}`, 200, payment({ id: session.payment_id, status: "authorized" }))
      .reply("POST", `/v1/payments/${session.payment_id}/capture`, 200, payment({
        id: session.payment_id,
        status: "captured",
        captured: 10000,
      }))

    const result = await provider.capturePayment({ data: session })

    expect(result.data).toMatchObject({ status: "captured" })
  })

  it("is a no-op for auto-captured payments", async () => {
    const session = await initiate()
    fake.reply("GET", `/v1/payments/${session.payment_id}`, 200, payment({ id: session.payment_id }))

    await provider.capturePayment({ data: session })

    expect(fake.calls.some((c) => c.path.endsWith("/capture"))).toBe(false)
  })

  it("recovers when a retried capture already went through", async () => {
    const session = await initiate()
    fake
      .reply("GET", `/v1/payments/${session.payment_id}`, 200, payment({ id: session.payment_id, status: "authorized" }))
      .reply("GET", `/v1/payments/${session.payment_id}`, 200, payment({ id: session.payment_id, status: "captured" }))
      .reply("POST", `/v1/payments/${session.payment_id}/capture`, 400, { type: "invalid_request_error", message: "already captured" })

    await expect(provider.capturePayment({ data: session })).resolves.toMatchObject({
      data: { status: "captured" },
    })
  })

  it("refuses to capture a failed payment", async () => {
    const session = await initiate()
    fake.reply("GET", `/v1/payments/${session.payment_id}`, 200, payment({ id: session.payment_id, status: "failed" }))

    await expect(provider.capturePayment({ data: session })).rejects.toThrow(/cannot be captured/)
  })
})

describe("cancelPayment and deletePayment", () => {
  it("voids an authorized payment", async () => {
    const session = await initiate()
    fake
      .reply("GET", `/v1/payments/${session.payment_id}`, 200, payment({ id: session.payment_id, status: "authorized" }))
      .reply("POST", `/v1/payments/${session.payment_id}/void`, 200, payment({ id: session.payment_id, status: "voided" }))

    await expect(provider.cancelPayment({ data: session })).resolves.toMatchObject({
      data: { status: "voided" },
    })
  })

  it("cancels the intent when the shopper never paid", async () => {
    const session = await initiate()
    fake.reply("POST", "/v1/payment_intents/pi_1/cancel", 200, intent({ status: "canceled" }))

    await provider.cancelPayment({ data: session })

    expect(fake.calls.at(-1)!.path).toBe("/v1/payment_intents/pi_1/cancel")
  })

  it("deletes a session quietly even if the intent is already used", async () => {
    const session = await initiate()
    fake.reply("POST", "/v1/payment_intents/pi_1/cancel", 400, { type: "intent_not_cancelable" })

    await expect(provider.deletePayment({ data: session })).resolves.toEqual({ data: session })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("does not look up the payment when the intent was still unused", async () => {
    const session = await initiate()
    fake.reply("POST", "/v1/payment_intents/pi_1/cancel", 200, intent({ status: "canceled" }))

    await provider.deletePayment({ data: session })

    expect(fake.calls.some((c) => c.path === `/v1/payments/${session.payment_id}`)).toBe(false)
  })

  it.each(["paid", "authorized", "captured"] as const)(
    "refuses to delete a session whose payment is already %s",
    async (status) => {
      const session = await initiate()
      fake
        .reply("POST", "/v1/payment_intents/pi_1/cancel", 400, { type: "intent_not_fulfillable" })
        .reply("GET", `/v1/payments/${session.payment_id}`, 200, payment({
          id: session.payment_id,
          status,
        }))

      await expect(provider.deletePayment({ data: session })).rejects.toThrow(
        /already .* Complete the cart/
      )
    }
  )

  it("deletes a session whose payment failed", async () => {
    const session = await initiate()
    fake
      .reply("POST", "/v1/payment_intents/pi_1/cancel", 400, { type: "intent_not_fulfillable" })
      .reply("GET", `/v1/payments/${session.payment_id}`, 200, payment({
        id: session.payment_id,
        status: "failed",
      }))

    await expect(provider.deletePayment({ data: session })).resolves.toEqual({ data: session })
  })

  it("deletes a session whose payment does not match it", async () => {
    const session = await initiate()
    fake
      .reply("POST", "/v1/payment_intents/pi_1/cancel", 400, { type: "intent_not_fulfillable" })
      .reply("GET", `/v1/payments/${session.payment_id}`, 200, payment({
        id: session.payment_id,
        amount: 100,
      }))

    await expect(provider.deletePayment({ data: session })).resolves.toEqual({ data: session })
  })

  it("still deletes the session when Moyasar cannot be reached", async () => {
    const session = await initiate()
    fake
      .reply("POST", "/v1/payment_intents/pi_1/cancel", 503, { message: "unavailable" })
      .reply("GET", `/v1/payments/${session.payment_id}`, 503, { message: "unavailable" })

    await expect(provider.deletePayment({ data: session })).resolves.toEqual({ data: session })
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })

  it("deletes a session that never got a Moyasar intent", async () => {
    const data = { callback_url: "https://shop.example/checkout/moyasar" }

    await expect(provider.deletePayment({ data })).resolves.toEqual({ data })
    expect(fake.calls).toHaveLength(0)
  })
})

describe("refundPayment", () => {
  it("refunds the requested amount in minor units", async () => {
    const session = await initiate()
    fake.reply("POST", `/v1/payments/${session.payment_id}/refund`, 200, payment({
      id: session.payment_id,
      status: "refunded",
      refunded: 2550,
    }))

    const result = await provider.refundPayment({ amount: 25.5, data: session })

    expect(fake.calls.at(-1)!.body).toEqual({ amount: 2550 })
    expect(result.data).toMatchObject({ status: "refunded" })
  })

  it("explains refund failures", async () => {
    const session = await initiate()
    fake.reply("POST", `/v1/payments/${session.payment_id}/refund`, 400, {
      type: "invalid_request_error",
      message: "Insufficient balance",
    })

    await expect(provider.refundPayment({ amount: 10, data: session })).rejects.toThrow(
      /refund the payment.*Insufficient balance/
    )
  })
})

describe("getWebhookActionAndData", () => {
  function webhook(type: string, overrides: Record<string, unknown> = {}) {
    const body = {
      id: "evt_1",
      type,
      created_at: new Date().toISOString(),
      secret_token: OPTIONS.webhookSecret,
      live: false,
      data: payment(),
      ...overrides,
    }
    return { data: body, rawData: JSON.stringify(body), headers: {} }
  }

  it.each([
    ["payment_paid", "captured"],
    ["payment_captured", "captured"],
    ["payment_authorized", "authorized"],
    ["payment_failed", "failed"],
    ["payment_voided", "canceled"],
  ])("maps %s to %s", async (type, action) => {
    await expect(provider.getWebhookActionAndData(webhook(type))).resolves.toEqual({
      action,
      data: { session_id: "payses_1", amount: 100 },
    })
  })

  it("reads the raw body when the parsed body is missing", async () => {
    const { rawData } = webhook("payment_paid")
    const result = await provider.getWebhookActionAndData({ data: {}, rawData, headers: {} })
    expect(result.action).toBe("captured")
  })

  it("uses the captured amount for partial captures", async () => {
    const result = await provider.getWebhookActionAndData(
      webhook("payment_captured", { data: payment({ status: "captured", captured: 4000 }) })
    )
    expect(result.data!.amount).toBe(40)
  })

  it("ignores events with a wrong secret token", async () => {
    const result = await provider.getWebhookActionAndData(
      webhook("payment_paid", { secret_token: "guess" })
    )
    expect(result).toEqual({ action: "not_supported" })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("secret token"))
  })

  it("ignores every event when no webhook secret is configured", async () => {
    provider = build({ webhookSecret: undefined })
    expect((await provider.getWebhookActionAndData(webhook("payment_paid"))).action).toBe(
      "not_supported"
    )
  })

  it("ignores live events on test keys", async () => {
    const result = await provider.getWebhookActionAndData(webhook("payment_paid", { live: true }))
    expect(result.action).toBe("not_supported")
  })

  it("ignores payments that did not come from Medusa", async () => {
    const result = await provider.getWebhookActionAndData(
      webhook("payment_paid", { data: payment({ metadata: {} }) })
    )
    expect(result.action).toBe("not_supported")
  })

  it("ignores events it does not handle", async () => {
    expect((await provider.getWebhookActionAndData(webhook("payment_refunded"))).action).toBe(
      "not_supported"
    )
  })

  it("logs the verification code so the merchant can activate the webhook", async () => {
    await provider.getWebhookActionAndData(
      webhook("webhook_verification", { data: { verification_code: "123456" } })
    )
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("123456"))
  })

  it("ignores malformed bodies", async () => {
    const result = await provider.getWebhookActionAndData({ data: {}, rawData: "nope", headers: {} })
    expect(result.action).toBe("not_supported")
  })
})
