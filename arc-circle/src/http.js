// The one place an unpaid HTTP request is made: no redirect is followed and none waits forever.
export function request(fetchFn, url, init = {}, timeoutMs = 60_000) {
  return fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
}
