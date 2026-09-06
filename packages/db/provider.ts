// The card processor, as a function (PRD 3 P0-4's "the provider call").
//
// Lifted out of `refund.ts` by C-069 because a second thing now goes through
// it. It resolves with the provider's reference or it THROWS. One failure
// channel, not two: a returned error object and a rejected promise are the
// same fact wearing different clothes, and a caller that has to handle both
// eventually handles one of them wrong. Every real SDK in this space throws.
//
// There is no real processor and the master PRD's Non-Goal says there will not
// be one. What matters is that the SEAM is here and that everything on this
// side of it — the request, the hold, the attempt, the failure, the retry — is
// real.

/** What is being asked of the processor. Three operations, one seam.
 *
 *  NAMED and not implied by the caller, which is the difference between a seam
 *  and a shape: a real adapter is handed this function and has to decide which
 *  API call to make, and `(key, amount)` alone does not tell it whether money
 *  is arriving or leaving. */
export type ProviderOperation =
  /** Hold the money without taking it (C-069). */
  | 'authorize'
  /** Take a hold (C-069). */
  | 'capture'
  /** Let a hold go (C-069). Nothing moved, so nothing goes back. */
  | 'void'
  /** Send money back (C-067). */
  | 'refund';

/**
 * `idempotencyKey` is always an `OrderEvent` row id — the request's for a
 * refund, the hold's for a capture or a void. It is a uuid, it is unique
 * because it is a primary key, and it is durable before the first call is
 * made, so a retry after a lost response presents the same key and the
 * PROVIDER, not this code, is what stops the customer being charged or paid
 * twice.
 */
export type PaymentProvider = (
  operation: ProviderOperation,
  idempotencyKey: string,
  amountCents: number,
) => Promise<string>;

/** The mock. Always succeeds, and the reference it returns names the operation
 *  and the key it was given, which is the honest record of what was asked. */
export const mockPaymentProvider: PaymentProvider = async (operation, idempotencyKey) =>
  `mock_${operation}_${idempotencyKey}`;
