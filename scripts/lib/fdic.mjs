// FDIC BankFind Suite API client. Every page of one pull must come from the same
// FDIC index build, so a pull that straddles an FDIC refresh is rejected whole.
import { fdicUrl } from './urls.mjs';
import { fetchJson, sleep } from './http.mjs';
import { FDIC_PAGE } from './constants.mjs';

export class FdicError extends Error {
  constructor(message) { super(message); this.name = 'FdicError'; }
}

function indexOf(body) {
  const index = body?.meta?.index;
  if (!index || typeof index.name !== 'string' || typeof index.createTimestamp !== 'string') throw new FdicError('FDIC response has no index metadata');
  return { name: index.name, createTimestamp: index.createTimestamp };
}

export async function fdicPull(endpoint, { filters, fields, sortBy, http, spacingMs = 250 }) {
  const rows = [];
  let total = null;
  let index = null;
  for (let offset = 0; total === null || offset < total; offset += FDIC_PAGE) {
    const url = fdicUrl(endpoint, { filters, fields, sortBy, limit: FDIC_PAGE, offset });
    const body = await fetchJson(url, { maxBytes: 80_000_000, timeoutMs: 120_000, ...http });
    const pageIndex = indexOf(body);
    if (index && pageIndex.name !== index.name) throw new FdicError(`FDIC ${endpoint} index changed during the pull (${index.name} to ${pageIndex.name})`);
    index = pageIndex;
    if (!Number.isInteger(body.meta?.total)) throw new FdicError(`FDIC ${endpoint} response has no total`);
    if (total !== null && body.meta.total !== total) throw new FdicError(`FDIC ${endpoint} total changed during the pull`);
    total = body.meta.total;
    if (!Array.isArray(body.data)) throw new FdicError(`FDIC ${endpoint} response has no data array`);
    for (const item of body.data) {
      if (!item || typeof item.data !== 'object') throw new FdicError(`FDIC ${endpoint} row without data`);
      rows.push(item.data);
    }
    if (body.data.length === 0) break;
    if (offset + FDIC_PAGE < total) await sleep(spacingMs);
  }
  if (rows.length !== total) throw new FdicError(`FDIC ${endpoint} returned ${rows.length} rows; meta.total is ${total}`);
  return { rows, total, index };
}

// One tiny request: the index build name changes whenever FDIC republishes the endpoint.
export async function fdicProbe(endpoint, { filters, field, http }) {
  const body = await fetchJson(fdicUrl(endpoint, { filters, fields: [field], limit: 1 }), { maxBytes: 100_000, ...http });
  return { index: indexOf(body), total: body.meta?.total ?? null, first: body.data?.[0]?.data ?? null };
}

export async function latestReportDate(http) {
  const body = await fetchJson(fdicUrl('financials', { fields: ['REPDTE'], sortBy: 'REPDTE', sortOrder: 'DESC', limit: 1 }), { maxBytes: 100_000, ...http });
  const value = body?.data?.[0]?.data?.REPDTE;
  if (!/^\d{8}$/.test(value ?? '')) throw new FdicError('FDIC latest REPDTE is not YYYYMMDD');
  return { repdte: value, index: indexOf(body) };
}

// Largest value of one field (for example the latest SOD year) in one tiny request.
export async function latestValue(endpoint, field, http) {
  const body = await fetchJson(fdicUrl(endpoint, { fields: [field], sortBy: field, sortOrder: 'DESC', limit: 1 }), { maxBytes: 100_000, ...http });
  return { value: body?.data?.[0]?.data?.[field] ?? null, index: indexOf(body) };
}

export const isoDate = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
