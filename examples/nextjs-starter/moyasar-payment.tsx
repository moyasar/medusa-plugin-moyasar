"use client"

import { useEffect, useRef, useState } from "react"
import "moyasar-payment-form/dist/moyasar.css"

type MoyasarSession = {
  intent_id: string
  client_secret: string
  payment_id: string
  amount: number
  currency: string
  description: string
  callback_url: string
  publishable_api_key: string
  methods: string[]
  manual: boolean
  metadata: Record<string, string>
}

type Props = {
  session: MoyasarSession
  locale?: "ar" | "en"
  applePay?: { country: string; label: string; validate_merchant_url?: string }
}

export default function MoyasarPayment({ session, locale = "en", applePay }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false

    import("moyasar-payment-form").then(({ default: Moyasar }) => {
      if (cancelled || !container.current) return
      container.current.innerHTML = ""

      Moyasar.init({
        element: container.current,
        language: locale,
        publishable_api_key: session.publishable_api_key,
        amount: session.amount,
        currency: session.currency,
        description: session.description,
        callback_url: session.callback_url,
        methods: session.methods,
        metadata: session.metadata,
        given_id: session.payment_id,
        use_payment_intent: true,
        payment_intent: { id: session.intent_id, client_secret: session.client_secret },
        credit_card: { manual: session.manual },
        ...(applePay && { apple_pay: { ...applePay, manual: session.manual } }),
        on_failure: async (failure: unknown) => {
          setError(typeof failure === "string" ? failure : (failure as { message?: string }).message)
        },
      })
    })

    return () => {
      cancelled = true
    }
  }, [session.intent_id, session.client_secret, locale])

  return (
    <div>
      <div ref={container} className="mysr-form" />
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
