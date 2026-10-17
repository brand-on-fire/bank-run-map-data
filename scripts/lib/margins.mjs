// Federal Reserve discount window collateral margins (frbdiscountwindow.org, HTML only).
// Parses the securities table and both loan tables (in scope, out of scope). A cell
// "a - b - c" gives the minimum, weighted-average and maximum margin seen on past
// pledges; the weighted average is kept. Margins are percent of market value.
import { fetchText } from './http.mjs';
import { marginsUrl } from './urls.mjs';

export class MarginsError extends Error {
  constructor(message) { super(message); this.name = 'MarginsError'; }
}

const decode = (s) => s.replace(/<[^>]+>/g, ' ').replaceAll('&nbsp;', ' ').replaceAll('&amp;', '&').replaceAll('&#39;', "'").replaceAll('&quot;', '"').replace(/\s+/g, ' ').trim();

function tableRows(html) {
  return [...html.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((tr) => [...tr[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => decode(c[1])));
}

function margin(cell) {
  if (cell === undefined || cell === '') return null;
  const parts = cell.split(' - ').map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p) || p < 0 || p > 100)) return undefined;
  return parts.length === 3 ? parts[1] : parts[0];
}

const SECURITY_BUCKETS = ['0-1', '>1-3', '>3-5', '>5-10', '>10'];
const LOAN_TENORS = [1, 3, 5, 7, 10, 15, 20, 25, 30];

export function parseMargins(rawHtml) {
  const html = rawHtml.replace(/<(script|style)[\s\S]*?<\/\1>/g, '');
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => tableRows(m[0]));
  if (tables.length < 3) throw new MarginsError(`Expected 3 margin tables, found ${tables.length}`);
  const effective = (rows) => {
    const cell = rows.flat().find((c) => /^Effective Date:/i.test(c));
    if (!cell) throw new MarginsError('Margin table has no effective date');
    return cell.replace(/^Effective Date:\s*/i, '');
  };

  // Securities: section headings are one-cell rows; data rows carry 1 label + up to 5 margins.
  const securities = [];
  let section = null;
  for (const row of tables[0]) {
    if (row.length === 1 && row[0] && !/^Effective|^Duration|^Securities/i.test(row[0])) { section = row[0]; continue; }
    if (row.length >= 2 && section) {
      const values = row.slice(1).map(margin);
      if (values.some((v) => v === undefined)) throw new MarginsError(`Bad securities margin in ${row[0]}`);
      securities.push({ section, item: row[0], byDuration: Object.fromEntries(SECURITY_BUCKETS.map((b, i) => [b, values[i] ?? null])) });
    }
  }

  // Loans: category, coupon, rating and repayment carry down from the rows above.
  const loans = (rows, scope) => {
    const out = [];
    let carry = { category: null, coupon: null, rating: null, repayment: null };
    for (const row of rows) {
      if (row.length < 3 || /^Effective|^Loan Category|^In Scope|^Out of Scope/i.test(row[0])) continue;
      const numericFrom = row.findIndex((c, i) => i > 0 && margin(c) !== undefined && margin(c) !== null);
      if (numericFrom < 1) continue;
      const labels = row.slice(0, numericFrom);
      const values = row.slice(numericFrom).map(margin);
      if (values.some((v) => v === undefined)) throw new MarginsError(`Bad loan margin in ${labels.join(' / ')}`);
      // Labels fill from the right: the last label is the most specific.
      const fields = ['category', 'coupon', 'rating', 'repayment'];
      const known = labels.filter(Boolean);
      const isCategory = known.length && !/^(Floating|Fixed|Minimal|Normal|Fully Amortizing|Bullet)$/.test(known[0]);
      if (isCategory) carry = { category: known[0], coupon: null, rating: null, repayment: null };
      for (const label of isCategory ? known.slice(1) : known) {
        if (/^(Floating|Fixed)$/.test(label)) { carry.coupon = label; carry.rating = null; carry.repayment = null; }
        else if (/^(Minimal|Normal)$/.test(label)) { carry.rating = label; carry.repayment = null; }
        else if (/^(Fully Amortizing|Bullet)$/.test(label)) carry.repayment = label;
      }
      void fields;
      const byTenor = values.length === 1 ? { flat: values[0] } : Object.fromEntries(LOAN_TENORS.map((t, i) => [t, values[i] ?? null]));
      out.push({ scope, ...carry, byTenor });
    }
    return out;
  };

  const parsed = {
    effective: { securities: effective(tables[0]), inScope: effective(tables[1]), outOfScope: effective(tables[2]) },
    securities,
    loans: [...loans(tables[1], 'in'), ...loans(tables[2], 'out')],
  };
  checkMargins(parsed);
  return parsed;
}

// Structure and range checks; a failure keeps the last good copy.
export function checkMargins(parsed) {
  const find = (section, item) => parsed.securities.find((s) => s.section.startsWith(section) && s.item.startsWith(item));
  const treasury = find('U.S. Treasuries', 'Bills, Notes, Bonds');
  const passThrough = find('Agency Backed Mortgages', 'Pass-Throughs');
  if (!treasury || !passThrough) throw new MarginsError('Treasury or agency pass-through margins are missing');
  if (!(treasury.byDuration['0-1'] >= 90)) throw new MarginsError('Treasury short margin is out of range');
  const needed = ['1-4 Family Mortgage Loans (first lien)', 'Commercial Real Estate Loans', 'Construction Loans', 'Commercial and Industrial Loans & Leases'];
  for (const scope of ['in', 'out']) {
    for (const category of needed) {
      if (!parsed.loans.some((l) => l.scope === scope && l.category === category && l.coupon === 'Fixed')) throw new MarginsError(`${scope}-scope fixed margins for ${category} are missing`);
    }
  }
  if (parsed.securities.length < 30 || parsed.loans.length < 60) throw new MarginsError('Margin tables are smaller than expected');
}

export async function fetchMargins(http) {
  return parseMargins(await fetchText(marginsUrl(), { ...http, maxBytes: 3_000_000, accept: 'text/html' }));
}
