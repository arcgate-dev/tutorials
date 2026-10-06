import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const RESPONSE_HEADERS = ['content-type', 'payment-required', 'payment-response', 'x-request-id'];
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// Every `secret` becomes '<redacted>': a secret is shown once, and a fixture is never a place to keep one.
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'secret' ? '<redacted>' : redact(item)]));
  }
  return value;
}

// /openapi.json is large; the fixture keeps only what a test reads: each operation's id and price.
function reduceOpenapi(spec) {
  const paths = {};
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const operation = methods[method];
      if (!operation?.operationId) continue;
      paths[path] ??= {};
      paths[path][method] = { operationId: operation.operationId, ...operation['x-payment'] && { 'x-payment': operation['x-payment'] } };
    }
  }
  return { paths };
}

// Wraps a fetch so every exchange is recorded for test/fixtures. The caller still gets the real answer.
// What is kept: the method, the path without its origin, the JSON request body, the status, four
// response headers and the redacted JSON answer. Request headers (the payment and agent signatures,
// the inbound secret) are never read.
export function recordingFetch(fetchFn, file) {
  const exchanges = [];

  async function fetch(url, init = {}) {
    const response = await fetchFn(url, init);
    const target = new URL(url);
    const text = await response.clone().text();
    const headers = Object.fromEntries(RESPONSE_HEADERS.flatMap(name => response.headers.has(name) ? [[name, response.headers.get(name)]] : []));
    let body = text ? JSON.parse(text) : undefined;
    if (body !== undefined) body = target.pathname === '/openapi.json' ? reduceOpenapi(body) : redact(body);
    exchanges.push({
      method: (init.method ?? 'GET').toUpperCase(), path: target.pathname + target.search,
      ...init.body != null && { requestBody: JSON.parse(Buffer.from(init.body).toString('utf8')) },
      status: response.status, headers, ...body !== undefined && { body },
    });
    return response;
  }

  async function save({ address, apiUrl }) {
    const capture = { capturedAt: new Date().toISOString(), apiUrl, apiCommit: process.env.CAPTURE_API_COMMIT ?? null, address, exchanges };
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(capture, null, 2)}\n`);
  }

  return { fetch, save };
}
