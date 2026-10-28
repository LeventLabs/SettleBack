import type { PrepareInput } from "../rail.ts";
import { HSK_NETWORKS, X402_METHOD, type CartContents } from "./cart-mandate.ts";

/**
 * The receiving agent's Cart Mandate contents for one job: a single x402 payment option on the
 * operation's chain and token, paid to the seller, for exactly the job's USD price. No modifiers,
 * so the amount due is the price; gateway fees appear only in the payment record's pay_amount.
 * The contents depend only on the input, so the same order always hashes the same.
 */
export function quoteContents(input: PrepareInput, merchantName: string): CartContents {
  const network = HSK_NETWORKS[input.chainId];
  if (network === undefined) throw new Error(`chain ${input.chainId} is not an HSK Chain network the gateway lists`);
  const amount = () => ({ currency: "USD" as const, value: input.priceUsd });
  return {
    id: input.cartMandateId,
    user_cart_confirmation_required: false,
    payment_request: {
      method_data: [
        {
          supported_methods: X402_METHOD,
          data: { x402Version: 2, network, chain_id: input.chainId, contract_address: input.token, pay_to: input.payee, coin: input.coin },
        },
      ],
      details: {
        id: input.paymentRequestId,
        display_items: [{ label: input.label, amount: amount() }],
        total: { label: "Total", amount: amount() },
      },
    },
    cart_expiry: input.expiresAt,
    merchant_name: merchantName,
  };
}
