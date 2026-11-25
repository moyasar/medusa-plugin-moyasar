declare module "moyasar-payment-form" {
  export default class Moyasar {
    static init(config: Record<string, unknown>): void
    static setAmount(amount: number): void
  }
}
