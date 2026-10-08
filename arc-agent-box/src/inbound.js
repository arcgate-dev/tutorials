import { createHmac } from 'node:crypto';
import { inboundUrl } from './config.js';
import { request } from './http.js';

// Posts to an inbound address the way an outside service would: no wallet, no payment, only the secret.
//  - 'signature': INBOUND-TIMESTAMP and INBOUND-SIGNATURE, the lowercase hex HMAC-SHA256 keyed by the
//    secret's UTF-8 bytes over `${timestamp}.` and the raw body bytes.
//  - 'secret': the secret itself in INBOUND-SECRET, for a sender that cannot sign.
// The answer is returned, not thrown: a 401 is something the step shows.
export async function postInbound({ url, secret, body, mode, now = Date.now, fetchFn = fetch }) {
  inboundUrl(url);
  const raw = JSON.stringify(body);
  const headers = { 'content-type': 'application/json' };
  if (mode === 'signature') {
    const timestamp = String(Math.floor(now() / 1000));
    headers['INBOUND-TIMESTAMP'] = timestamp;
    headers['INBOUND-SIGNATURE'] = createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${timestamp}.`).update(Buffer.from(raw)).digest('hex');
  } else if (mode === 'secret') {
    headers['INBOUND-SECRET'] = secret;
  } else {
    throw new Error('mode is signature or secret.');
  }
  const response = await request(fetchFn, url, { method: 'POST', headers, body: raw });
  return { status: response.status, body: await response.json() };
}
