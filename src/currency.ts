import type { BigNumberInput } from "@medusajs/framework/types"
import { BigNumber, MathBN } from "@medusajs/framework/utils"

const fractionDigitsCache = new Map<string, number>()

export function fractionDigits(currency: string): number {
  const code = currency.toUpperCase()
  const cached = fractionDigitsCache.get(code)
  if (cached !== undefined) {
    return cached
  }

  const digits = new Intl.NumberFormat("en", {
    style: "currency",
    currency: code,
  }).resolvedOptions().maximumFractionDigits ?? 2

  fractionDigitsCache.set(code, digits)
  return digits
}

export function toMinorUnits(amount: BigNumberInput, currency: string): number {
  const digits = fractionDigits(currency)
  const scaled = new BigNumber(MathBN.mult(amount, 10 ** digits)).numeric
  const minor = Math.round(scaled)

  if (digits === 3) {
    return Math.round(minor / 10) * 10
  }

  return minor
}

export function fromMinorUnits(amount: number, currency: string): number {
  const digits = fractionDigits(currency)
  return new BigNumber(MathBN.div(amount, 10 ** digits)).numeric
}
