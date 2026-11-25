import { initiatePaymentSession, placeOrder, retrieveCart } from "@lib/data/cart"
import { unstable_rethrow } from "next/navigation"
import { NextRequest, NextResponse } from "next/server"

const PROVIDER_ID = "pp_moyasar_moyasar"

function redirectTo(path: string) {
  return new NextResponse(null, { status: 307, headers: { Location: path } })
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const cartId = searchParams.get("cart_id")
  const countryCode = searchParams.get("country_code") ?? "sa"
  const checkout = new URLSearchParams({ step: "payment" })

  if (!cartId) {
    return redirectTo(`/${countryCode}/checkout?${checkout}`)
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
  const callbackUrl = cart?.payment_collection?.payment_sessions?.find(
    (session) => session.provider_id === PROVIDER_ID
  )?.data?.callback_url

  if (cart && !cart.completed_at && typeof callbackUrl === "string") {
    await initiatePaymentSession(cart, {
      provider_id: PROVIDER_ID,
      data: { callback_url: callbackUrl },
    }).catch(() => undefined)
  }

  checkout.set("error", error)
  return redirectTo(`/${countryCode}/checkout?${checkout}`)
}
