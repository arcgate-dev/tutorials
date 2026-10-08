// Preserve the API's next action and optional free quote for callers, without
// automatically retrying a payment or accepting a different trade.
export class ArcgateError extends Error {
  constructor(operation, response, body, paymentResponse) {
    const requestId = response.headers.get('x-request-id');
    // Arcgate errors carry { code, message, hint }; the x402 middleware's 502 carries a plain string.
    const reason = typeof body.error === 'string' ? body.error : body.error?.code ?? 'request_failed';
    const paid = ['search', 'quote', 'swap'].includes(operation);
    super(`${operation}: HTTP ${response.status} (${reason})`
      + (body.next ? `; next=${body.next}` : '')
      + (body.retryAfterSec !== undefined ? `; retryAfterSec=${body.retryAfterSec}` : '')
      + (body.error?.hint ? `; ${body.error.hint}` : '')
      + (paymentResponse?.success === false ? `; payment settlement failed: ${paymentResponse.errorReason ?? 'unknown reason'}` : '')
      + ((paid && response.status === 502) || paymentResponse?.errorReason === 'payment_response_expired'
        ? '; the payment may have settled; check the PAYMENT-RESPONSE transaction or your USDC balance before paying again' : '')
      + (response.status === 402 && paid
        ? '; check the payment amount, authorization and USDC balance before starting a new paid run' : '')
      + (body.quote ? `; free replacement quote ${body.quote.quoteId} available for review` : '')
      + (requestId ? `; requestId=${requestId}` : '')
      + '. No automatic retry.');
    this.name = 'ArcgateError';
    this.status = response.status;
    this.requestId = requestId;
    this.body = body;
    this.paymentResponse = paymentResponse;
  }
}

export async function readApiResponse(operation, response, record = () => {}, paymentResponse) {
  let body;
  try { body = await response.json(); }
  catch {
    throw new Error(`${operation}: unreadable response (HTTP ${response.status}, requestId=${response.headers.get('x-request-id') ?? 'unknown'}). Outcome may be uncertain; do not automatically retry.`);
  }
  if (!response.ok) {
    const error = new ArcgateError(operation, response, body, paymentResponse);
    record({ operation, state: 'error', status: error.status, requestId: error.requestId,
      error: body.error, next: body.next, retryAfterSec: body.retryAfterSec, quote: body.quote, paymentResponse });
    throw error;
  }
  return body;
}
