import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  BigNumberInput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  PaymentProviderContext,
  PaymentSessionStatus as PaymentSessionStatusValue,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import {
  AbstractPaymentProvider,
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import { MoyasarApiError, MoyasarClient } from "./client"
import { fromMinorUnits, toMinorUnits } from "./currency"
import type {
  MoyasarOptions,
  MoyasarPayment,
  MoyasarPaymentMethod,
  MoyasarPaymentStatus,
  MoyasarSessionData,
  MoyasarWebhookEvent,
} from "./types"

type InjectedDependencies = {
  logger?: Logger
}

const DEFAULT_METHODS: MoyasarPaymentMethod[] = ["creditcard", "applepay", "stcpay"]
const SUPPORTED_METHODS = new Set<MoyasarPaymentMethod>([
  "creditcard",
  "applepay",
  "samsungpay",
  "stcpay",
])
const INTENT_REFRESH_MARGIN_MS = 5 * 60 * 1000
const SESSION_ID_METADATA_KEY = "medusa_session_id"
const SUCCESSFUL_STATUSES = new Set<MoyasarPaymentStatus>([
  "paid",
  "authorized",
  "captured",
  "refunded",
])

export class MoyasarProviderService extends AbstractPaymentProvider<MoyasarOptions> {
  static override identifier = "moyasar"

  protected readonly options_: MoyasarOptions
  protected readonly client_: MoyasarClient
  protected readonly logger_: Logger | undefined

  static override validateOptions(options: Record<string, unknown>): void {
    const { secretKey, publishableKey, methods, callbackUrl } =
      options as Partial<MoyasarOptions>

    if (typeof secretKey !== "string" || !/^sk_(test|live)_/.test(secretKey)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        "Moyasar: `secretKey` is required and must start with `sk_test_` or `sk_live_`."
      )
    }

    if (
      typeof publishableKey !== "string" ||
      !/^pk_(test|live)_/.test(publishableKey)
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        "Moyasar: `publishableKey` is required and must start with `pk_test_` or `pk_live_`."
      )
    }

    if (keyMode(secretKey) !== keyMode(publishableKey)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        "Moyasar: `secretKey` and `publishableKey` must both be test keys or both be live keys."
      )
    }

    if (methods !== undefined) {
      const invalid = methods.filter((method) => !SUPPORTED_METHODS.has(method))
      if (!methods.length || invalid.length) {
        throw new MedusaError(
          MedusaError.Types.INVALID_ARGUMENT,
          `Moyasar: \`methods\` must be a non-empty subset of ${[...SUPPORTED_METHODS].join(", ")}.`
        )
      }
    }

    if (callbackUrl !== undefined && !isHttpUrl(callbackUrl)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        "Moyasar: `callbackUrl` must be an absolute http(s) URL."
      )
    }
  }

  constructor(container: InjectedDependencies, options: MoyasarOptions) {
    super(container as Record<string, unknown>, options)

    this.options_ = options
    this.logger_ = container.logger
    this.client_ = new MoyasarClient({
      secretKey: options.secretKey,
      ...(options.apiBaseUrl !== undefined && { baseUrl: options.apiBaseUrl }),
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      ...(options.maxNetworkRetries !== undefined && {
        maxNetworkRetries: options.maxNetworkRetries,
      }),
    })

    if (!options.webhookSecret) {
      this.logger_?.warn(
        "Moyasar: `webhookSecret` is not set, so webhooks are ignored. Payments still complete when the shopper returns to the store, but orders are not created if they close the tab after paying."
      )
    }
  }

  async initiatePayment({
    amount,
    currency_code,
    data,
    context,
  }: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const session = await this.createSession(amount, currency_code, data, context)

    return {
      id: session.intent_id,
      status: PaymentSessionStatus.PENDING,
      data: session,
    }
  }

  async updatePayment({
    amount,
    currency_code,
    data,
    context,
  }: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const session = this.sessionData(data)
    const minorAmount = toMinorUnits(amount, currency_code)
    const unchanged =
      session.amount === minorAmount &&
      session.currency === currency_code.toUpperCase()

    if (unchanged && !isExpiring(session.expires_at)) {
      return { status: PaymentSessionStatus.PENDING, data: session }
    }

    const payment = await this.findPayment(session.payment_id)

    if (payment && payment.status !== "failed") {
      if (unchanged) {
        return { status: this.statusFor(payment, session), data: { ...session, payment } }
      }

      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Moyasar: payment ${payment.id} is already ${payment.status}, so the amount can no longer change.`
      )
    }

    await this.cancelIntentQuietly(session.intent_id)

    const next = await this.createSession(amount, currency_code, {
      ...data,
      callback_url: session.callback_url,
      session_id: session.session_id,
    }, context)

    return { status: PaymentSessionStatus.PENDING, data: next }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    return this.getPaymentStatus(input)
  }

  async getPaymentStatus({ data }: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const session = this.sessionData(data)
    const payment = await this.findPayment(session.payment_id)

    if (!payment) {
      return {
        status: isExpiring(session.expires_at, 0)
          ? PaymentSessionStatus.ERROR
          : PaymentSessionStatus.REQUIRES_MORE,
        data: session,
      }
    }

    return {
      status: this.statusFor(payment, session),
      data: { ...session, status: payment.status, payment },
    }
  }

  async capturePayment({ data }: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const session = this.sessionData(data)
    const payment = await this.requirePayment(session.payment_id)

    if (payment.status === "paid" || payment.status === "captured") {
      return { data: { ...session, status: payment.status, payment } }
    }

    if (payment.status !== "authorized") {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Moyasar: payment ${payment.id} is ${payment.status} and cannot be captured.`
      )
    }

    try {
      const captured = await this.client_.capturePayment(payment.id)
      return { data: { ...session, status: captured.status, payment: captured } }
    } catch (error) {
      const current = await this.findPayment(payment.id)
      if (current?.status === "captured") {
        return { data: { ...session, status: current.status, payment: current } }
      }
      throw this.wrap("capture the payment", error)
    }
  }

  async cancelPayment({ data }: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const session = this.sessionData(data)
    const payment = await this.findPayment(session.payment_id)

    if (!payment) {
      await this.cancelIntentQuietly(session.intent_id)
      return { data: session }
    }

    if (payment.status !== "authorized") {
      return { data: { ...session, status: payment.status, payment } }
    }

    try {
      const voided = await this.client_.voidPayment(payment.id)
      return { data: { ...session, status: voided.status, payment: voided } }
    } catch (error) {
      const current = await this.findPayment(payment.id)
      if (current?.status === "voided") {
        return { data: { ...session, status: current.status, payment: current } }
      }
      throw this.wrap("void the payment", error)
    }
  }

  async deletePayment({ data }: DeletePaymentInput): Promise<DeletePaymentOutput> {
    const session = this.sessionData(data)
    await this.cancelIntentQuietly(session.intent_id)
    return { data: session }
  }

  async refundPayment({ amount, data }: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const session = this.sessionData(data)
    const minorAmount = toMinorUnits(amount, session.currency)

    try {
      const refunded = await this.client_.refundPayment(session.payment_id, minorAmount)
      return { data: { ...session, status: refunded.status, payment: refunded } }
    } catch (error) {
      throw this.wrap("refund the payment", error)
    }
  }

  async retrievePayment({ data }: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const session = this.sessionData(data)
    const payment = await this.requirePayment(session.payment_id)
    return { data: { ...session, status: payment.status, payment } }
  }

  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const event = parseWebhook(payload)
    if (!event) {
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    if (!this.isAuthentic(event)) {
      this.logger_?.warn(
        `Moyasar: ignored webhook ${event.id ?? "without id"} because its secret token does not match \`webhookSecret\`.`
      )
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    if (event.type === "webhook_verification") {
      const code = (event.data as unknown as { verification_code?: string })
        ?.verification_code
      this.logger_?.info(
        `Moyasar: webhook verification code is ${code}. Enter it in the Moyasar dashboard to activate this webhook.`
      )
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    if (event.live !== (keyMode(this.options_.secretKey) === "live")) {
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    const payment = event.data
    const sessionId = payment?.metadata?.[SESSION_ID_METADATA_KEY]
    if (!payment?.id || !sessionId) {
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    const action = WEBHOOK_ACTIONS[event.type]
    if (!action) {
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    const minorAmount =
      event.type === "payment_captured" && payment.captured > 0
        ? payment.captured
        : payment.amount

    return {
      action,
      data: {
        session_id: sessionId,
        amount: fromMinorUnits(minorAmount, payment.currency),
      },
    }
  }

  protected async createSession(
    amount: BigNumberInput,
    currencyCode: string,
    data: Record<string, unknown> | undefined,
    context: PaymentProviderContext | undefined
  ): Promise<MoyasarSessionData> {
    const currency = currencyCode.toUpperCase()
    const minorAmount = toMinorUnits(amount, currency)
    const sessionId = stringOrUndefined(data?.session_id)
    const callbackUrl = stringOrUndefined(data?.callback_url) ?? this.options_.callbackUrl

    if (callbackUrl !== undefined && !isHttpUrl(callbackUrl)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Moyasar: `callback_url` must be an absolute http(s) URL."
      )
    }

    const description = [
      this.options_.paymentDescription ?? "Medusa order",
      sessionId && `(${sessionId})`,
    ]
      .filter(Boolean)
      .join(" ")

    try {
      const intent = await this.client_.createPaymentIntent({
        amount: minorAmount,
        currency,
        description,
        ...(callbackUrl !== undefined && { callback_url: callbackUrl }),
      })

      const metadata: Record<string, string> = {}
      if (sessionId) metadata[SESSION_ID_METADATA_KEY] = sessionId
      if (context?.customer?.id) metadata.medusa_customer_id = context.customer.id

      return {
        intent_id: intent.id,
        client_secret: intent.client_secret,
        payment_id: randomUUID(),
        ...(sessionId !== undefined && { session_id: sessionId }),
        amount: intent.amount,
        currency: intent.currency,
        description,
        ...(callbackUrl !== undefined && { callback_url: callbackUrl }),
        publishable_api_key: this.options_.publishableKey,
        methods: this.options_.methods ?? DEFAULT_METHODS,
        manual: this.options_.capture === false,
        metadata,
        expires_at: intent.expires_at,
      }
    } catch (error) {
      throw this.wrap("create the payment intent", error)
    }
  }

  protected statusFor(
    payment: MoyasarPayment,
    session: MoyasarSessionData
  ): PaymentSessionStatusValue {
    if (SUCCESSFUL_STATUSES.has(payment.status) && !this.matchesSession(payment, session)) {
      this.logger_?.error(
        `Moyasar: payment ${payment.id} is ${payment.amount} ${payment.currency} but session ${session.session_id ?? session.intent_id} expects ${session.amount} ${session.currency}. Refusing to authorize it.`
      )
      return PaymentSessionStatus.ERROR
    }

    switch (payment.status) {
      case "authorized":
        return PaymentSessionStatus.AUTHORIZED
      case "paid":
      case "captured":
      case "refunded":
        return PaymentSessionStatus.CAPTURED
      case "initiated":
        return PaymentSessionStatus.REQUIRES_MORE
      case "pending":
        return PaymentSessionStatus.PENDING
      case "voided":
        return PaymentSessionStatus.CANCELED
      case "failed":
      case "expired":
      case "verified":
      default:
        return PaymentSessionStatus.ERROR
    }
  }

  protected matchesSession(payment: MoyasarPayment, session: MoyasarSessionData): boolean {
    return (
      payment.id === session.payment_id &&
      payment.amount === session.amount &&
      payment.currency.toUpperCase() === session.currency.toUpperCase()
    )
  }

  protected isAuthentic(event: MoyasarWebhookEvent): boolean {
    const secret = this.options_.webhookSecret
    if (!secret || typeof event.secret_token !== "string") {
      return false
    }

    return timingSafeEqual(digest(event.secret_token), digest(secret))
  }

  protected async findPayment(id: string): Promise<MoyasarPayment | undefined> {
    try {
      return await this.client_.retrievePayment(id)
    } catch (error) {
      if (error instanceof MoyasarApiError && error.isNotFound) {
        return undefined
      }
      throw this.wrap("retrieve the payment", error)
    }
  }

  protected async requirePayment(id: string): Promise<MoyasarPayment> {
    const payment = await this.findPayment(id)
    if (!payment) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Moyasar: payment ${id} was not found. The shopper has not paid yet.`
      )
    }
    return payment
  }

  protected async cancelIntentQuietly(intentId: string): Promise<void> {
    try {
      await this.client_.cancelPaymentIntent(intentId)
    } catch (error) {
      if (!(error instanceof MoyasarApiError && error.status < 500)) {
        this.logger_?.warn(
          `Moyasar: could not cancel payment intent ${intentId}: ${(error as Error).message}`
        )
      }
    }
  }

  protected sessionData(data: Record<string, unknown> | undefined): MoyasarSessionData {
    if (!data || typeof data.payment_id !== "string" || typeof data.intent_id !== "string") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Moyasar: the payment session has no Moyasar intent. Initiate the session again."
      )
    }
    return data as MoyasarSessionData
  }

  protected wrap(action: string, error: unknown): MedusaError {
    if (error instanceof MedusaError) {
      return error
    }

    if (error instanceof MoyasarApiError) {
      const type =
        error.status === 404
          ? MedusaError.Types.NOT_FOUND
          : error.status < 500
            ? MedusaError.Types.NOT_ALLOWED
            : MedusaError.Types.UNEXPECTED_STATE
      const detail = error.type ? ` (${error.type})` : ""
      return new MedusaError(type, `Moyasar: could not ${action}${detail}: ${error.message}`)
    }

    return new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `Moyasar: could not ${action}: ${(error as Error)?.message ?? String(error)}`
    )
  }
}

const WEBHOOK_ACTIONS: Partial<Record<string, PaymentActions>> = {
  payment_paid: PaymentActions.SUCCESSFUL,
  payment_captured: PaymentActions.SUCCESSFUL,
  payment_authorized: PaymentActions.AUTHORIZED,
  payment_failed: PaymentActions.FAILED,
  payment_faild: PaymentActions.FAILED,
  payment_expired: PaymentActions.FAILED,
  payment_voided: PaymentActions.CANCELED,
}

function parseWebhook(
  payload: ProviderWebhookPayload["payload"]
): MoyasarWebhookEvent | undefined {
  const body =
    payload.data && Object.keys(payload.data).length
      ? payload.data
      : rawJson(payload.rawData)

  if (!body || typeof body !== "object" || typeof (body as { type?: unknown }).type !== "string") {
    return undefined
  }

  return body as unknown as MoyasarWebhookEvent
}

function rawJson(raw: string | Buffer | undefined): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw.toString())
  } catch {
    return undefined
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest()
}

function keyMode(key: string): "test" | "live" {
  return key.includes("_live_") ? "live" : "test"
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === "https:" || protocol === "http:"
  } catch {
    return false
  }
}

function isExpiring(expiresAt: string, marginMs = INTENT_REFRESH_MARGIN_MS): boolean {
  const time = Date.parse(expiresAt)
  return Number.isNaN(time) || time - marginMs <= Date.now()
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined
}

export default MoyasarProviderService
