// Treasury par yield curve (daily) and FRED H.15 series (history for presets and betas).
import { fetchText } from './http.mjs';
import { treasuryCurveUrl, fredUrl } from './urls.mjs';
import { parseCsv } from './csv.mjs';

export class RatesError extends Error {
  constructor(message) { super(message); this.name = 'RatesError'; }
}

// Tenor labels Treasury uses, in years. "1.5 Month" and "4 Mo" appear in later years only.
export const TENORS = Object.freeze({
  '1 Mo': 1 / 12, '1.5 Month': 1.5 / 12, '2 Mo': 2 / 12, '3 Mo': 0.25, '4 Mo': 4 / 12, '6 Mo': 0.5,
  '1 Yr': 1, '2 Yr': 2, '3 Yr': 3, '5 Yr': 5, '7 Yr': 7, '10 Yr': 10, '20 Yr': 20, '30 Yr': 30,
});
const REQUIRED = ['3 Mo', '1 Yr', '2 Yr', '5 Yr', '10 Yr', '30 Yr'];

function normalizeCsv(text) {
  // Treasury ends lines with LF; the strict parser accepts LF or CRLF.
  return text.replace(/\r?\n?$/, '\n');
}

export function parseTreasuryCsv(text) {
  const { header, rows } = parseCsv(normalizeCsv(text));
  if (header[0] !== 'Date') throw new RatesError('Treasury CSV must start with Date');
  for (const label of REQUIRED) if (!header.includes(label)) throw new RatesError(`Treasury CSV lacks ${label}`);
  const unknown = header.slice(1).filter((h) => !(h in TENORS));
  if (unknown.length) throw new RatesError(`Treasury CSV has unknown tenors: ${unknown.join(', ')}`);
  return rows.map((row) => {
    const [month, day, year] = row[0].split('/');
    const date = `${year}-${month}-${day}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RatesError(`Bad Treasury date ${row[0]}`);
    const points = [];
    header.slice(1).forEach((label, i) => {
      const value = row[i + 1];
      if (value === '' || value === 'N/A') return;
      const y = Number(value);
      if (!Number.isFinite(y) || y < -1 || y > 25) throw new RatesError(`Treasury yield out of range on ${date}: ${label} ${value}`);
      points.push([TENORS[label], y]);
    });
    points.sort((a, b) => a[0] - b[0]);
    return { date, points };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

export async function treasuryYear(year, http) {
  return parseTreasuryCsv(await fetchText(treasuryCurveUrl(year), { ...http, maxBytes: 2_000_000, accept: 'text/csv' }));
}

// Latest curve on or before an ISO date (quarter ends can fall on holidays or weekends).
export function curveOnOrBefore(curves, isoDate) {
  let found = null;
  for (const curve of curves) if (curve.date <= isoDate) found = curve;
  return found;
}

export function parseFredCsv(text, series) {
  const { header, rows } = parseCsv(normalizeCsv(text));
  if (header[0] !== 'observation_date' || series.some((s, i) => header[i + 1] !== s)) throw new RatesError(`FRED header ${header.join(',')} does not match ${series.join(',')}`);
  const out = Object.fromEntries(series.map((s) => [s, []]));
  for (const row of rows) {
    series.forEach((s, i) => {
      const v = row[i + 1];
      if (v === '' || v === '.') return;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new RatesError(`FRED ${s} value ${v} on ${row[0]}`);
      out[s].push([row[0], n]);
    });
  }
  return out;
}

export async function fredSeries(series, http) {
  return parseFredCsv(await fetchText(fredUrl(series), { ...http, maxBytes: 8_000_000, accept: 'text/csv' }), series);
}

// Largest rise of a daily series over any 365-day window.
export function worstTwelveMonthRise(points) {
  let best = { rise: 0, from: null, to: null };
  let j = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [date, value] = points[i];
    const limit = new Date(Date.parse(date) - 365 * 86_400_000).toISOString().slice(0, 10);
    while (j < i && points[j][0] < limit) j += 1;
    // The window start is the first observation on or after date minus 365 days.
    const [fromDate, fromValue] = points[j];
    if (value - fromValue > best.rise) best = { rise: Number((value - fromValue).toFixed(2)), from: [fromDate, fromValue], to: [date, value] };
  }
  return best;
}

export function valueOnOrBefore(points, isoDate) {
  let found = null;
  for (const point of points) { if (point[0] <= isoDate) found = point; else break; }
  return found;
}
