import { describe, expect, it } from "vitest"
import { fractionDigits, fromMinorUnits, toMinorUnits } from "./currency"

describe("currency", () => {
  it.each([
    ["SAR", 2],
    ["usd", 2],
    ["KWD", 3],
    ["BHD", 3],
    ["JPY", 0],
  ])("knows %s has %i fraction digits", (code, digits) => {
    expect(fractionDigits(code)).toBe(digits)
  })

  it("converts to minor units without float drift", () => {
    expect(toMinorUnits(100, "SAR")).toBe(10000)
    expect(toMinorUnits(19.99, "SAR")).toBe(1999)
    expect(toMinorUnits(0.1 + 0.2, "SAR")).toBe(30)
    expect(toMinorUnits("1234.56", "AED")).toBe(123456)
    expect(toMinorUnits(500, "JPY")).toBe(500)
  })

  it("rounds three-decimal currencies to a trailing zero as Moyasar requires", () => {
    expect(toMinorUnits(1.234, "KWD")).toBe(1230)
    expect(toMinorUnits(1.236, "KWD")).toBe(1240)
    expect(toMinorUnits(2.5, "BHD")).toBe(2500)
  })

  it("converts back to major units", () => {
    expect(fromMinorUnits(1999, "SAR")).toBe(19.99)
    expect(fromMinorUnits(1230, "KWD")).toBe(1.23)
    expect(fromMinorUnits(500, "JPY")).toBe(500)
  })
})
