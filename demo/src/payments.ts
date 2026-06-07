// Demo file 2 of 3 — illustrates stripe charge handling mistakes Nark catches.
//
// Payment code is the canonical case for "errors are not optional." Every
// charge has a non-zero chance of failing for reasons the application has
// to know about: declined cards, insufficient funds, fraud blocks, network
// issues between you and Stripe's API.

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");

// Charges a customer for a one-off purchase.
// VIOLATION (stripe.error-4xx-5xx): no try/catch. A declined card throws
// `StripeCardError`; here that uncaught rejection means the request handler
// returns 500 with no useful information for the user — and the card is
// still on file for retry, so the failure mode is silent from the customer's
// perspective.
export async function chargeCustomer(
  amount: number,
  currency: string,
  source: string,
) {
  const charge = await stripe.charges.create({ amount, currency, source });
  return charge.id;
}

// Creates a new Stripe customer record at signup time.
// VIOLATION (stripe.error-4xx-5xx): no try/catch on the customer.create.
// A duplicate-email collision or a transient 502 from Stripe will throw
// and the signup flow will appear to silently fail.
export async function registerCustomer(email: string) {
  const customer = await stripe.customers.create({ email });
  return customer.id;
}
