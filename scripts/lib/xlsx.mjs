// Minimal XLSX reader for the Fed's lending disclosures: shared strings plus one
// worksheet, returned as rows of cell values keyed by column letter.
import { listZip, readZipEntry } from './zip.mjs';

export class XlsxError extends Error {
  constructor(message) { super(message); this.name = 'XlsxError'; }
}

const unescape = (s) => s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');

export function sheetNames(zip) {
  const entries = listZip(zip);
  const wb = entries.find((e) => e.name === 'xl/workbook.xml');
  if (!wb) throw new XlsxError('No workbook.xml');
  const xml = readZipEntry(zip, wb).toString('utf8');
  return [...xml.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map((m) => ({ name: unescape(m[1]), rid: m[2] }));
}

export function readSheet(zip, sheetIndex = 1) {
  const entries = listZip(zip);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const strings = [];
  const ss = byName.get('xl/sharedStrings.xml');
  if (ss) {
    const xml = readZipEntry(zip, ss).toString('utf8');
    for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) strings.push(unescape([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  }
  const sheet = byName.get(`xl/worksheets/sheet${sheetIndex}.xml`);
  if (!sheet) throw new XlsxError(`No sheet${sheetIndex}.xml`);
  const xml = readZipEntry(zip, sheet, { maxBytes: 400 * 1024 * 1024 }).toString('utf8');
  const rows = [];
  for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const type = /t="([^"]+)"/.exec(c[2])?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[3] ?? '')?.[1];
      const inline = /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[3] ?? '')?.[1];
      cells[c[1]] = type === 's' ? strings[Number(v)] : type === 'inlineStr' ? unescape(inline ?? '') : v === undefined ? null : unescape(v);
    }
    rows.push(cells);
  }
  return rows;
}

// Excel serial date to ISO (1900 system).
// Returns null for anything that is not a date (footnote rows, blanks).
export const excelDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (/^\d+(\.\d+)?$/.test(String(value))) return new Date(Date.UTC(1899, 11, 30) + Number(value) * 86_400_000).toISOString().slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value).trim());
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};
