import { initiatePaymentSession, placeOrder, retrieveCart } from "@lib/data/cart"
import { unstable_rethrow } from "next/navigation"
import { NextRequest, NextResponse } from "next/server"

const PROVIDER_ID = "pp_moyasar_moyasar"

export async function GET(request: NextRequest) {
  const { origin, searchParams } = request.nextUrl
  const cartId = searchParams.get("cart_id")
  const countryCode = searchParams.get("country_code") ?? "sa"
  const checkout = new URL(`/${countryCode}/checkout?step=payment`, origin)

  if (!cartId) {
    return NextResponse.redirect(checkout)
  }

  let error = searchParams.get("message") || "Payment failed"

  if (searchParams.get("status") !== "failed") {
    try {
      await placeOrder(cartId)
      error = "Payment was not completed"
    } catch (placeOrderError) {
      unstable_rethrow(placeOrderError)
      error = (placeOrderError as Error).message
    }
  }

  const cart = await retrieveCart(cartId)

  if (cart && !cart.completed_at) {
    const callbackUrl = new URL("/api/moyasar/callback", origin)
    callbackUrl.searchParams.set("cart_id", cartId)
    callbackUrl.searchParams.set("country_code", countryCode)

    await initiatePaymentSession(cart, {
      provider_id: PROVIDER_ID,
      data: { callback_url: callbackUrl.toString() },
    }).catch(() => undefined)
  }

  checkout.searchParams.set("error", error)
  return NextResponse.redirect(checkout)
}
