// Publication gates. Any failure stops publication; the last good data stays live.
import { blankRates, totals } from './build.mjs';

export class GateError extends Error {
  constructor(message, results) { super(message); this.name = 'GateError'; this.results = results; }
}

export function runGates({ fields, financials, table, previous, crossCheck, sodTie, districtCheck, fit, policy }) {
  const g = policy.gates;
  const results = [];
  const add = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail });

  // 1. Every requested FDIC field appears in at least one row.
  const seen = new Set();
  for (const row of financials) for (const key of Object.keys(row)) seen.add(key);
  const missing = fields.filter((f) => !seen.has(f));
  add('fdic-fields', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${fields.length} fields present`);

  // 2. Universe size against the last publication.
  if (previous?.totals?.banks) {
    const change = Math.abs(table.count / previous.totals.banks - 1);
    add('bank-count', change <= g.bankCountMaxChange, `${table.count} banks vs ${previous.totals.banks} last publication (${(change * 100).toFixed(1)}% change)`);
  } else add('bank-count', table.count > 3000, `${table.count} banks (first publication; floor 3,000)`);

  // 3. Blank rates per column stay within their recorded band.
  const rates = blankRates(table);
  if (previous?.blankRates) {
    const drift = Object.entries(rates).filter(([k, v]) => previous.blankRates[k] !== undefined && Math.abs(v - previous.blankRates[k]) > g.blankRateMaxDrift);
    add('blank-rates', drift.length === 0, drift.length ? drift.map(([k, v]) => `${k} ${previous.blankRates[k]} to ${v}`).join('; ') : 'within band');
  } else {
    const bad = Object.entries(rates).filter(([k, v]) => v > 0.5 && !['CHFRB', 'RTNVS'].includes(k));
    add('blank-rates', bad.length === 0, bad.length ? `mostly blank: ${bad.map(([k]) => k).join(', ')}` : 'first publication; only CHFRB and RTNVS may be mostly blank');
  }

  // 4. System totals move plausibly against the last publication (same or next quarter).
  const t = totals(table);
  if (previous?.totals) {
    const checks = Object.entries(g.totalsMaxQuarterChange).map(([k, max]) => [k, Math.abs(t[k] / previous.totals[k] - 1), max]);
    const bad = checks.filter(([, c, max]) => !(c <= max));
    add('totals', bad.length === 0, checks.map(([k, c]) => `${k} ${(c * 100).toFixed(1)}%`).join(', '));
  } else add('totals', t.assets > 1e10, `assets $${(t.assets / 1e9).toFixed(2)}T`);

  // 5. Independent FFIEC copy of the same filings agrees field by field.
  if (crossCheck) add('ffiec-cross-check', crossCheck.pass, Object.entries(crossCheck.fields).map(([k, v]) => `${k} ${(v.exactShare * 100).toFixed(2)}%`).join(', '));
  else add('ffiec-cross-check', false, 'FFIEC bulk file unavailable');

  // 6. Branch deposits tie to call report domestic deposits.
  add('sod-tie', sodTie.share >= g.sodTieShare, `${(sodTie.share * 100).toFixed(1)}% of banks within ${g.sodTieTolerance * 100}% (${sodTie.compared} compared, SOD ${sodTie.year})`);

  // 7. Every bank's FDIC district matches the county crosswalk.
  add('districts', districtCheck.mismatches === 0, `${districtCheck.matched} matched, ${districtCheck.mismatches} mismatched, ${districtCheck.skipped} skipped`);

  // 8. Mortgage-duration fit predicts out of sample.
  if (fit) add('duration-fit', fit.outOfSample.meanAbsErrorModel <= g.durationOutOfSampleMaxError && fit.outOfSample.meanAbsErrorModel < fit.outOfSample.meanAbsErrorNoChange, `out-of-sample error ${(fit.outOfSample.meanAbsErrorModel * 100).toFixed(1)}% vs ${(fit.outOfSample.meanAbsErrorNoChange * 100).toFixed(1)}% for no change`);

  const pass = results.every((r) => r.pass);
  return { pass, results, totals: t, blankRates: rates };
}

// SOD deposits are as of June 30 of their year; they tie to the Q2 call report.
export function sodTie(financials, sodRows, year, tolerance) {
  const sod = new Map();
  for (const r of sodRows) sod.set(Number(r.CERT), (sod.get(Number(r.CERT)) ?? 0) + Number(r.DEPSUMBR ?? 0));
  let compared = 0;
  let within = 0;
  for (const f of financials) {
    if (f.REPDTE !== `${year}0630` || !(f.DEPDOM > 0)) continue;
    const s = sod.get(Number(f.CERT));
    if (s === undefined) continue;
    compared += 1;
    if (Math.abs(s / f.DEPDOM - 1) <= tolerance) within += 1;
  }
  return { year, compared, within, share: compared ? within / compared : 1 };
}

// FDIC district per bank against the county crosswalk (Connecticut planning regions skipped).
export function districtCheck(institutions, crosswalk) {
  let matched = 0; let mismatches = 0; let skipped = 0;
  const examples = [];
  for (const inst of institutions) {
    if (Number(inst.ACTIVE) !== 1) continue;
    const fips = String(inst.STCNTY ?? '').padStart(5, '0');
    const expected = crosswalk.counties[fips] ?? crosswalk.territories?.[fips.slice(0, 2)];
    if (!expected) { skipped += 1; continue; }
    const override = crosswalk.checks?.fdicOverrides?.find?.((o) => o.fips === fips);
    if (String(inst.FED) === expected || override) matched += 1;
    else { mismatches += 1; if (examples.length < 10) examples.push({ fips, fdic: inst.FED, crosswalk: expected }); }
  }
  return { matched, mismatches, skipped, examples };
}
