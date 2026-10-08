// Preserve the API's next action for callers, without automatically retrying a payment.
export class ArcgateError extends Error {
  constructor(operation, response, body, paymentResponse, paid = false) {
    const requestId = response.headers.get('x-request-id');
    // Arcgate errors carry { code, message, hint }; the x402 middleware's 502 carries a plain string.
    const reason = typeof body.error === 'string' ? body.error : body.error?.code ?? 'request_failed';
    super(`${operation}: HTTP ${response.status} (${reason})`
      + (body.next ? `; next=${body.next}` : '')
      + (body.retryAfterSec !== undefined ? `; retryAfterSec=${body.retryAfterSec}` : '')
      + (body.error?.hint ? `; ${body.error.hint}` : '')
      + (paymentResponse?.success === false ? `; payment settlement failed: ${paymentResponse.errorReason ?? 'unknown reason'}` : '')
      + ((paid && response.status === 502) || paymentResponse?.errorReason === 'payment_response_expired'
        ? '; the payment may have settled; check the PAYMENT-RESPONSE transaction or your USDC balance before paying again' : '')
      + (response.status === 402 ? '; check the payment amount, authorization and USDC balance before starting a new paid run' : '')
      + (requestId ? `; requestId=${requestId}` : '')
      + '. No automatic retry.');
    this.name = 'ArcgateError';
    this.status = response.status;
    this.requestId = requestId;
    this.body = body;
    this.paymentResponse = paymentResponse;
  }
}

// The one place an HTTP request is made: no redirect is followed and none waits forever.
export function request(fetchFn, url, init = {}) {
  return fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(60_000) });
}

export async function readApiResponse(operation, response, record = () => {}, paymentResponse, paid = false) {
  let body;
  try { body = await response.json(); }
  catch {
    throw new Error(`${operation}: unreadable response (HTTP ${response.status}, requestId=${response.headers.get('x-request-id') ?? 'unknown'}). Outcome may be uncertain; do not automatically retry.`);
  }
  if (!response.ok) {
    const error = new ArcgateError(operation, response, body, paymentResponse, paid);
    record({ operation, state: 'error', status: error.status, requestId: error.requestId, error: body.error, next: body.next, retryAfterSec: body.retryAfterSec, paymentResponse });
    throw error;
  }
  return body;
}
