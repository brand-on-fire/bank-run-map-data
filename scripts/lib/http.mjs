// One bounded request. No redirects are followed (a 3xx is returned to the caller),
// the body is read completely or rejected at the byte cap, and nothing retries
// inside a run; a failed source waits for the next scheduled run.
import { assertRequestAllowed } from './urls.mjs';

export class FetchError extends Error {
  constructor(message, result) { super(message); this.name = 'FetchError'; this.result = result; }
}

export async function fetchBounded(url, {
  fetchImpl = globalThis.fetch, userAgent, timeoutMs = 60_000, maxBytes, method = 'GET', body, headers = {}, accept = '*/*',
}) {
  assertRequestAllowed(url);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes is required');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        body,
        redirect: 'manual',
        headers: { 'User-Agent': userAgent, Accept: accept, ...headers },
        signal: controller.signal,
      });
    } catch (error) {
      return { kind: controller.signal.aborted ? 'timeout' : 'network', status: null, bytes: 0, detail: error?.name ?? 'Error' };
    }
    const status = response.status;
    const chunks = [];
    let bytes = 0;
    try {
      if (response.body) {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > maxBytes) {
            controller.abort();
            return { kind: 'byte-cap', status, bytes, detail: `response exceeded ${maxBytes} bytes` };
          }
          chunks.push(Buffer.from(chunk));
        }
      }
    } catch (error) {
      return { kind: controller.signal.aborted ? 'timeout' : 'network', status, bytes, detail: error?.name ?? 'Error' };
    }
    return {
      kind: 'response',
      status,
      bytes,
      buffer: Buffer.concat(chunks),
      headers: response.headers,
      location: response.headers?.get?.('location') ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// A 200 with a complete body, or a FetchError naming what went wrong.
export async function fetchOk(url, options) {
  const result = await fetchBounded(url, options);
  if (result.kind !== 'response') throw new FetchError(`${new URL(url).hostname}: ${result.kind} (${result.detail})`, result);
  if (result.status !== 200) throw new FetchError(`${new URL(url).hostname}: HTTP ${result.status}`, result);
  return result;
}

export async function fetchJson(url, options) {
  const result = await fetchOk(url, { accept: 'application/json', ...options });
  try {
    return JSON.parse(result.buffer.toString('utf8'));
  } catch {
    throw new FetchError(`${new URL(url).hostname}: response is not JSON`, result);
  }
}

export async function fetchText(url, options) {
  const result = await fetchOk(url, options);
  return result.buffer.toString('utf8');
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
