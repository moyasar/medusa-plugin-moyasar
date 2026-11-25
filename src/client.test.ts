import { describe, expect, it } from "vitest"
import { MoyasarApiError, MoyasarClient, MoyasarNetworkError } from "./client"
import { FakeMoyasar, intent, payment } from "./test/fake-moyasar"

function client(fake: FakeMoyasar, maxNetworkRetries = 2) {
  return new MoyasarClient({ secretKey: "sk_test_123", fetch: fake.fetch, maxNetworkRetries })
}

describe("MoyasarClient", () => {
  it("authenticates with the secret key over basic auth", async () => {
    const fake = new FakeMoyasar().reply("GET", "/v1/payments/pay_1", 200, payment())

    await client(fake).retrievePayment("pay_1")

    expect(fake.calls[0]!.headers.Authorization).toBe(
      `Basic ${Buffer.from("sk_test_123:").toString("base64")}`
    )
  })

  it("sends JSON bodies", async () => {
    const fake = new FakeMoyasar().reply("POST", "/v1/payment_intents", 201, intent())

    await client(fake).createPaymentIntent({ amount: 10000, currency: "SAR" })

    expect(fake.calls[0]!.body).toEqual({ amount: 10000, currency: "SAR" })
    expect(fake.calls[0]!.headers["Content-Type"]).toBe("application/json")
  })

  it("raises typed API errors", async () => {
    const fake = new FakeMoyasar().reply("POST", "/v1/payments/pay_1/refund", 400, {
      type: "invalid_request_error",
      message: "Amount exceeds refundable amount",
    })

    const error = await client(fake).refundPayment("pay_1", 1).catch((e) => e)

    expect(error).toBeInstanceOf(MoyasarApiError)
    expect(error).toMatchObject({ status: 400, type: "invalid_request_error" })
  })

  it("retries reads on 5xx", async () => {
    const fake = new FakeMoyasar()
      .reply("GET", "/v1/payments/pay_1", 503, { message: "down" })
      .reply("GET", "/v1/payments/pay_1", 200, payment())

    await expect(client(fake).retrievePayment("pay_1")).resolves.toMatchObject({ id: "pay_1" })
    expect(fake.calls).toHaveLength(2)
  })

  it("never retries money-moving calls", async () => {
    const fake = new FakeMoyasar().reply("POST", "/v1/payments/pay_1/capture", 502, {})

    await expect(client(fake).capturePayment("pay_1")).rejects.toBeInstanceOf(MoyasarApiError)
    expect(fake.calls).toHaveLength(1)
  })

  it("wraps transport failures", async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError("fetch failed")
    }
    const c = new MoyasarClient({ secretKey: "sk_test_1", fetch: failing, maxNetworkRetries: 0 })

    await expect(c.retrievePayment("pay_1")).rejects.toBeInstanceOf(MoyasarNetworkError)
  })
})
