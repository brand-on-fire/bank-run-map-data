// FFIEC CDR bulk call reports: an independent copy of the same filings, used to
// cross-check the FDIC API before anything is published. The page is an ASP.NET
// form, so the download replays its postbacks (no login, no key).
import { fetchBounded, FetchError } from './http.mjs';
import { ffiecBulkUrl } from './urls.mjs';
import { listZip, readZipEntry } from './zip.mjs';

export class FfiecError extends Error {
  constructor(message) { super(message); this.name = 'FfiecError'; }
}

const PRODUCT = 'ReportingSeriesSinglePeriod';
const FIELD_PREFIX = 'ctl00$MainContentHolder$';

function hiddenFields(html) {
  const fields = {};
  for (const match of html.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) {
    fields[match[1]] = match[2].replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&#39;', "'");
  }
  if (!fields.__VIEWSTATE) throw new FfiecError('FFIEC form has no view state');
  return fields;
}

class CookieJar {
  constructor() { this.cookies = new Map(); }
  take(headers) {
    for (const line of headers?.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      if (at > 0) this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function step(url, jar, http, { form, maxBytes }) {
  const result = await fetchBounded(url, {
    ...http,
    maxBytes,
    method: form ? 'POST' : 'GET',
    body: form ? new URLSearchParams(form).toString() : undefined,
    headers: { ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(jar.cookies.size ? { Cookie: jar.header() } : {}) },
  });
  if (result.kind !== 'response' || result.status !== 200) throw new FetchError(`FFIEC bulk download: ${result.kind === 'response' ? `HTTP ${result.status}` : result.kind}`, result);
  jar.take(result.headers);
  return result;
}

// period: 'MM/DD/YYYY' as the form lists it. Returns the zip bytes.
export async function downloadCallBulk(period, http) {
  const url = ffiecBulkUrl();
  const jar = new CookieJar();
  const first = await step(url, jar, http, { maxBytes: 2_000_000 });
  const pick = {
    ...hiddenFields(first.buffer.toString('utf8')),
    __EVENTTARGET: `${FIELD_PREFIX}ListBox1`, __EVENTARGUMENT: '',
    [`${FIELD_PREFIX}ListBox1`]: PRODUCT, [`${FIELD_PREFIX}FormatType`]: 'TSVRadioButton',
  };
  const second = await step(url, jar, http, { form: pick, maxBytes: 2_000_000 });
  const html = second.buffer.toString('utf8');
  const list = /DatesDropDownList"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? '';
  const options = [...list.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => ({ value: m[1], label: m[2].trim() }));
  const option = options.find((o) => o.label === period);
  if (!option) throw new FfiecError(`FFIEC does not list ${period} yet (latest ${options[0]?.label ?? 'none'})`);
  const download = {
    ...hiddenFields(html),
    __EVENTTARGET: '', __EVENTARGUMENT: '',
    [`${FIELD_PREFIX}ListBox1`]: PRODUCT, [`${FIELD_PREFIX}DatesDropDownList`]: option.value,
    [`${FIELD_PREFIX}FormatType`]: 'TSVRadioButton', [`${FIELD_PREFIX}TabStrip1$Download_0`]: 'Download',
  };
  const file = await step(url, jar, http, { form: download, maxBytes: 60_000_000 });
  const disposition = file.headers.get('content-disposition') ?? '';
  const expected = `FFIEC CDR Call Bulk All Schedules ${period.replaceAll('/', '')}.zip`;
  if (!disposition.includes(expected)) throw new FfiecError(`FFIEC returned ${disposition || 'no attachment'}, expected ${expected}`);
  return file.buffer;
}

// Reads every file whose name contains `part` into Map<IDRSSD, {MDRM: number|string}>.
export function readSchedules(zip, parts) {
  const entries = listZip(zip);
  const tables = {};
  for (const part of parts) {
    const rows = new Map();
    const files = entries.filter((e) => e.name.includes(part));
    if (files.length === 0) throw new FfiecError(`FFIEC zip has no file matching "${part}"`);
    for (const file of files) {
      const lines = readZipEntry(zip, file).toString('latin1').split(/\r?\n/).filter((line) => line.length);
      const header = lines[0].split('\t').map((h) => h.replaceAll('"', '').trim());
      if (header[0] !== 'IDRSSD') throw new FfiecError(`${file.name} does not start with IDRSSD`);
      for (const line of lines.slice(2)) {
        const cells = line.split('\t');
        const id = cells[0].replaceAll('"', '').trim();
        const record = rows.get(id) ?? {};
        for (let i = 1; i < header.length; i += 1) {
          const cell = (cells[i] ?? '').replaceAll('"', '').trim();
          if (cell !== '') record[header[i]] = cell;
        }
        rows.set(id, record);
      }
    }
    tables[part] = rows;
  }
  return tables;
}

// Compares FDIC rows to the FFIEC filings field by field.
export function crossCheck(fdicRows, tables, spec) {
  const por = tables.POR;
  const certToId = new Map();
  for (const [id, record] of por) certToId.set(String(record['FDIC Certificate Number']), id);
  const value = (record, code) => {
    if (!record) return null;
    const keys = code.startsWith('RC') ? [code] : [`RCFD${code}`, `RCON${code}`];
    for (const key of keys) if (record[key] !== undefined) return Number(record[key]);
    return null;
  };
  const results = {};
  for (const [field, rule] of Object.entries(spec.fields)) {
    const table = tables[rule.schedule];
    let compared = 0;
    let exact = 0;
    let fdicSum = 0;
    let ffiecSum = 0;
    for (const row of fdicRows) {
      const id = certToId.get(String(row.CERT));
      const record = id ? table.get(id) : null;
      const parts = rule.codes.map((code) => value(record, code));
      if (parts.every((p) => p === null) || row[field] === null || row[field] === undefined) continue;
      const theirs = parts.reduce((sum, p) => sum + (p ?? 0), 0);
      compared += 1;
      fdicSum += row[field];
      ffiecSum += theirs;
      if (Math.abs(theirs - row[field]) <= Math.max(1, Math.abs(row[field]) * 1e-6)) exact += 1;
    }
    const exactShare = compared ? exact / compared : 0;
    const gap = ffiecSum ? Math.abs(fdicSum - ffiecSum) / Math.abs(ffiecSum) : 1;
    results[field] = { compared, exact, exactShare: Number(exactShare.toFixed(4)), aggregateGap: Number(gap.toFixed(5)), pass: compared > 0 && exactShare >= spec.minExactShare && gap <= spec.maxAggregateGap };
  }
  return { linked: [...certToId.keys()].length, fields: results, pass: Object.values(results).every((r) => r.pass) };
}
