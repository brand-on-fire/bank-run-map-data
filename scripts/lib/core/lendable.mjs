// Discount window lendable value of a bank's collateral at the Fed's published
// margins. Shared by the pipeline and the app.
//
// Gross collateral: every security at fair value and every loan at book value,
// less what is already encumbered elsewhere:
//   securities: SCPLEDGE (pledged for public deposits, repo or FHLB);
//   loans: FHLB advances divided by FHLB_LENDING_VALUE (loans held at the FHLB).
// Assumptions are named here and listed in the app's facts.
import { parDuration, yieldAt } from './curve.mjs';
import { SECURITY_BUCKETS, groupScales } from './marks.mjs';

export const FHLB_LENDING_VALUE = 0.75; // assumption: FHLB lends about 75 cents per dollar of loan collateral
export const IN_SCOPE_ASSETS = 50_000_000; // thousands: the Fed's in-scope test is roughly $50B holding companies

const SECURITY_ROWS = Object.freeze({
  treasury: ['U.S. Treasuries', 'Bills, Notes, Bonds'],
  agency: ['Government Sponsored Enterprises', 'Bills, Notes, and Bonds'],
  agencyMbs: ['Agency Backed Mortgages', 'Pass-Throughs'],
  privateRmbs: ['Non Agency Backed Mortgages', 'Residential Mortgage Backed - AAA'],
  otherCmbs: ['Non Agency Backed Mortgages', 'Commercial Mortgage Backed - AAA'],
  muni: ['Municipal Bonds', 'AAA-A rated'],
  other: ['Corporate Bonds', 'A rated - Financials'],
});

const durationBucket = (d) => (d <= 1 ? '0-1' : d <= 3 ? '>1-3' : d <= 5 ? '>3-5' : d <= 10 ? '>5-10' : '>10');

function securityMargin(margins, kind, duration) {
  const [section, item] = SECURITY_ROWS[kind];
  const row = margins.securities.find((s) => s.section.startsWith(section) && s.item.startsWith(item));
  const value = row?.byDuration[durationBucket(duration)] ?? row?.byDuration['>10'];
  if (!Number.isFinite(value)) throw new RangeError(`No margin for ${kind}`);
  return value / 100;
}

const LOAN_TENORS = [1, 3, 5, 7, 10, 15, 20, 25, 30];
const nearestTenor = (t) => LOAN_TENORS.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), 1);

function loanMargin(margins, scope, category, coupon, tenor) {
  const rows = margins.loans.filter((l) => l.scope === scope && l.category === category && l.coupon === coupon);
  // Normal risk rating where the table splits by rating (the stricter of the two).
  const row = rows.find((l) => l.rating === 'Normal' && (l.repayment === null || l.repayment === 'Fully Amortizing'))
    ?? rows.find((l) => l.rating === null && (l.repayment === null || l.repayment === 'Fully Amortizing'))
    ?? rows[0];
  const value = row?.byTenor?.[nearestTenor(tenor)] ?? row?.byTenor?.flat;
  if (!Number.isFinite(value)) throw new RangeError(`No loan margin for ${category} ${coupon}`);
  return value / 100;
}

// Weighted average margin over a set of buckets for one security kind.
function bucketedSecurityMargin(row, margins, kind, buckets, curve, scale) {
  let total = 0;
  let weighted = 0;
  for (const b of buckets) {
    const amount = row[b.field] ?? 0;
    if (amount <= 0) continue;
    const duration = parDuration(b.tenor, yieldAt(curve, b.tenor)) * scale;
    total += amount;
    weighted += amount * securityMargin(margins, kind, duration);
  }
  return total > 0 ? weighted / total : securityMargin(margins, kind, 3);
}

export function lendableValue(row, margins, curve, fit) {
  const scale = groupScales(fit);
  const nonMortgage = SECURITY_BUCKETS.filter((b) => b.group === 'nonMortgage');
  const mortgage = SECURITY_BUCKETS.filter((b) => b.group !== 'nonMortgage');
  const fv = Math.max(0, (row.SCAF ?? 0) + (row.SCHF ?? 0));
  const book = Math.max(1, (row.SCAA ?? 0) + (row.SCHA ?? 0));
  const free = Math.max(0, fv - (row.SCPLEDGE ?? 0) * (fv / book));
  const parts = {
    treasury: row.SCUST ?? 0,
    agency: row.SCAGE ?? 0,
    privateRmbs: row.SCRMBPI ?? 0,
    otherCmbs: row.SCCMOS ?? 0,
    muni: row.SCMUNI ?? 0,
  };
  parts.agencyMbs = Math.max(0, (row.SCMTGBK ?? 0) - parts.privateRmbs - parts.otherCmbs);
  const named = Object.values(parts).reduce((s, v) => s + v, 0);
  parts.other = Math.max(0, book - named);
  const totalParts = Math.max(1, Object.values(parts).reduce((s, v) => s + v, 0));
  let securities = 0;
  for (const [kind, amount] of Object.entries(parts)) {
    if (amount <= 0) continue;
    const isMortgage = kind === 'agencyMbs' || kind === 'privateRmbs' || kind === 'otherCmbs';
    const m = bucketedSecurityMargin(row, margins, kind, isMortgage ? mortgage : nonMortgage, curve, isMortgage ? scale.passThrough : 1);
    securities += free * (amount / totalParts) * m;
  }

  const scope = (row.ASSET ?? 0) >= IN_SCOPE_ASSETS ? 'in' : 'out';
  const loansGross = Math.max(0, row.LNLSGR ?? 0);
  const fhlbHeld = Math.min(loansGross, (row.OTHBFHLB ?? 0) / FHLB_LENDING_VALUE);
  const freeShare = loansGross > 0 ? (loansGross - fhlbHeld) / loansGross : 0;
  const cre = Math.max(0, (row.LNRENRES ?? 0) + (row.LNREMULT ?? 0));
  const construction = Math.max(0, row.LNRECONS ?? 0);
  let loans = 0;
  const addBucket = (amount, tenor, category) => {
    if (amount <= 0) return;
    const coupon = tenor <= 1 ? 'Floating' : 'Fixed';
    loans += amount * freeShare * loanMargin(margins, scope, category, coupon, Math.max(1, tenor));
  };
  for (const b of ['LNRS3LES', 'LNRS3T12', 'LNRS1T3', 'LNRS3T5', 'LNRS5T15', 'LNRSOV15']) {
    addBucket(row[b] ?? 0, { LNRS3LES: 0.125, LNRS3T12: 0.625, LNRS1T3: 2, LNRS3T5: 4, LNRS5T15: 10, LNRSOV15: 20 }[b], '1-4 Family Mortgage Loans (first lien)');
  }
  // Other loans: CRE and construction at their own margins, the rest at C&I margins,
  // each spread over the bank's other-loan repricing buckets.
  const otherBuckets = { LNOT3LES: 0.125, LNOT3T12: 0.625, LNOT1T3: 2, LNOT3T5: 4, LNOT5T15: 10, LNOTOV15: 20 };
  const otherTotal = Object.keys(otherBuckets).reduce((s, b) => s + Math.max(0, row[b] ?? 0), 0);
  if (otherTotal > 0) {
    const shares = { 'Commercial Real Estate Loans': Math.min(1, cre / otherTotal), 'Construction Loans': Math.min(1, construction / otherTotal) };
    shares['Commercial and Industrial Loans & Leases'] = Math.max(0, 1 - shares['Commercial Real Estate Loans'] - shares['Construction Loans']);
    for (const [b, tenor] of Object.entries(otherBuckets)) {
      const amount = Math.max(0, row[b] ?? 0);
      for (const [category, share] of Object.entries(shares)) addBucket(amount * share, tenor, category);
    }
  }
  return { securities, loans, total: securities + loans, scope };
}
