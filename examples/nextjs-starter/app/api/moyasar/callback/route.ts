import { NextRequest, NextResponse } from "next/server"
import { sdk } from "@lib/config"

export async function GET(request: NextRequest) {
  const url = request.nextUrl
  const cartId = url.searchParams.get("cart_id")
  const countryCode = url.searchParams.get("country_code") ?? "sa"
  const checkout = new URL(`/${countryCode}/checkout?step=payment`, url.origin)

  if (!cartId) {
    return NextResponse.redirect(checkout)
  }

  if (url.searchParams.get("status") === "failed") {
    checkout.searchParams.set("error", url.searchParams.get("message") ?? "Payment failed")
    return NextResponse.redirect(checkout)
  }

  try {
    const result = await sdk.store.cart.complete(cartId)

    if (result.type === "order") {
      return NextResponse.redirect(
        new URL(`/${countryCode}/order/${result.order.id}/confirmed`, url.origin)
      )
    }

    checkout.searchParams.set("error", result.error?.message ?? "Payment was not completed")
  } catch (error) {
    checkout.searchParams.set("error", (error as Error).message)
  }

  return NextResponse.redirect(checkout)
}
