// Marks a bank's securities and loans from its filing date to another curve,
// bucket by bucket, from the call report maturity and repricing schedules
// (RC-B memo 2, RC-C memo 2). Shared by the pipeline and the app.
import { yieldAt, parDuration } from './curve.mjs';

// Bucket midpoints in years. Remaining maturity or next repricing date.
export const SECURITY_BUCKETS = Object.freeze([
  { field: 'SCNM3LES', group: 'nonMortgage', tenor: 0.125 },
  { field: 'SCNM3T12', group: 'nonMortgage', tenor: 0.625 },
  { field: 'SCNM1T3', group: 'nonMortgage', tenor: 2 },
  { field: 'SCNM3T5', group: 'nonMortgage', tenor: 4 },
  { field: 'SCNM5T15', group: 'nonMortgage', tenor: 10 },
  { field: 'SCNMOV15', group: 'nonMortgage', tenor: 20 },
  { field: 'SCPT3LES', group: 'passThrough', tenor: 0.125 },
  { field: 'SCPT3T12', group: 'passThrough', tenor: 0.625 },
  { field: 'SCPT1T3', group: 'passThrough', tenor: 2 },
  { field: 'SCPT3T5', group: 'passThrough', tenor: 4 },
  { field: 'SCPT5T15', group: 'passThrough', tenor: 10 },
  { field: 'SCPTOV15', group: 'passThrough', tenor: 20 },
  { field: 'SCO3YLES', group: 'otherMortgage', tenor: 1.5 },
  { field: 'SCOOV3Y', group: 'otherMortgage', tenor: 7 },
]);

export const LOAN_BUCKETS = Object.freeze([
  { field: 'LNRS3LES', group: 'residential', tenor: 0.125 },
  { field: 'LNRS3T12', group: 'residential', tenor: 0.625 },
  { field: 'LNRS1T3', group: 'residential', tenor: 2 },
  { field: 'LNRS3T5', group: 'residential', tenor: 4 },
  { field: 'LNRS5T15', group: 'residential', tenor: 10 },
  { field: 'LNRSOV15', group: 'residential', tenor: 20 },
  { field: 'LNOT3LES', group: 'otherLoans', tenor: 0.125 },
  { field: 'LNOT3T12', group: 'otherLoans', tenor: 0.625 },
  { field: 'LNOT1T3', group: 'otherLoans', tenor: 2 },
  { field: 'LNOT3T5', group: 'otherLoans', tenor: 4 },
  { field: 'LNOT5T15', group: 'otherLoans', tenor: 10 },
  { field: 'LNOTOV15', group: 'otherLoans', tenor: 20 },
]);

// Duration scale per group. Non-mortgage securities and other loans use par-bond
// duration (scale 1). Mortgage groups use the scale fitted from the call reports
// themselves (calibration.mortgageDuration); residential loans borrow the
// pass-through scale because both prepay the same way (assumption).
export function groupScales(fit) {
  return {
    nonMortgage: fit?.nonMortgage ?? 1,
    passThrough: fit?.passThrough ?? 1,
    otherMortgage: fit?.otherMortgage ?? 1,
    residential: fit?.passThrough ?? 1,
    otherLoans: 1,
  };
}

// Exposure terms x_g = -sum(w_b * D_b * dy_b / 100) per group, for weights w_b in
// dollars. Returns dollar price changes per group (before scaling).
export function exposures(row, buckets, fromCurve, toCurve) {
  const out = {};
  for (const b of buckets) {
    const amount = row[b.field] ?? 0;
    if (!amount) continue;
    const y0 = yieldAt(fromCurve, b.tenor);
    const dy = yieldAt(toCurve, b.tenor) - y0;
    out[b.group] = (out[b.group] ?? 0) - amount * parDuration(b.tenor, y0) * (dy / 100);
  }
  return out;
}

// Dollar change in market value from fromCurve to toCurve (FDIC thousands).
export function markChange(row, fromCurve, toCurve, fit) {
  const scale = groupScales(fit);
  const sec = exposures(row, SECURITY_BUCKETS, fromCurve, toCurve);
  const loans = exposures(row, LOAN_BUCKETS, fromCurve, toCurve);
  const sum = (x) => Object.entries(x).reduce((s, [g, v]) => s + v * scale[g], 0);
  // Buckets cover AFS at fair value and HTM at amortized cost; the change applies
  // to the market value of what is held, so it is taken as is.
  return { securities: sum(sec), loans: sum(loans) };
}

// Unrealized loss on securities (positive number = loss) on toCurve.
export function securitiesLossOn(row, fromCurve, toCurve, fit) {
  const reported = ((row.SCAA ?? 0) - (row.SCAF ?? 0)) + ((row.SCHA ?? 0) - (row.SCHF ?? 0));
  return reported - markChange(row, fromCurve, toCurve, fit).securities;
}
