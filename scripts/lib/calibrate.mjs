// Calibrations fitted from public data at each rebuild. Every output carries the
// numbers needed to audit it (sample sizes, fit statistics, out-of-sample errors).
import { yieldAt } from './core/curve.mjs';
import { exposures, SECURITY_BUCKETS } from './core/marks.mjs';
import { lendableValue } from './core/lendable.mjs';
import { valueOnOrBefore } from './rates.mjs';

const quarterKey = (iso) => `${iso.slice(0, 4)}-Q${Math.ceil(Number(iso.slice(5, 7)) / 3)}`;
const iso = (repdte) => `${repdte.slice(0, 4)}-${repdte.slice(4, 6)}-${repdte.slice(6, 8)}`;
const round = (v, d = 4) => Number(v.toFixed(d));

export function quarterlyAverages(points) {
  const sums = new Map();
  for (const [date, value] of points) {
    const key = quarterKey(date);
    const s = sums.get(key) ?? [0, 0];
    s[0] += value; s[1] += 1;
    sums.set(key, s);
  }
  return new Map([...sums].map(([k, [sum, n]]) => [k, sum / n]));
}

function byCertAndDate(history) {
  const map = new Map();
  for (const row of history) {
    const cert = Number(row.CERT);
    if (!map.has(cert)) map.set(cert, new Map());
    map.get(cert).set(row.REPDTE, row);
  }
  return map;
}

// Deposit beta (Drechsler, Savov, Schnabl and Wang): change in the annualized
// domestic deposit cost over the change in the fed funds rate across the 2022-23
// hiking cycle, 2021 Q4 to 2023 Q4.
export function depositBetas(history, effr, { from = '20211231', to = '20231231' } = {}) {
  const panel = byCertAndDate(history);
  const prevOf = (date) => {
    const y = Number(date.slice(0, 4)); const m = Number(date.slice(4, 6));
    return m === 3 ? `${y - 1}1231` : `${y}${String(m - 3).padStart(2, '0')}${m - 3 === 6 ? '30' : m - 3 === 9 ? '30' : '31'}`;
  };
  const rateAt = (rows, date) => {
    const now = rows.get(date); const before = rows.get(prevOf(date));
    if (!now || !(now.DEPDOM > 0) || now.EDEPDOMQ === null || now.EDEPDOMQ === undefined) return null;
    // Average of the two quarter-end balances when both are on file, else the quarter end.
    const base = before?.DEPDOM > 0 ? (now.DEPDOM + before.DEPDOM) / 2 : now.DEPDOM;
    return (4 * now.EDEPDOMQ) / base * 100;
  };
  const dFF = effr.get(quarterKey(iso(to))) - effr.get(quarterKey(iso(from)));
  if (!(dFF > 1)) throw new Error('Fed funds change over the beta window is too small');
  const betas = new Map();
  const values = [];
  for (const [cert, rows] of panel) {
    const r0 = rateAt(rows, from); const r1 = rateAt(rows, to);
    if (r0 === null || r1 === null) continue;
    const beta = Math.min(1.2, Math.max(0, (r1 - r0) / dFF));
    betas.set(cert, round(beta, 3));
    values.push(beta);
  }
  if (values.length === 0) throw new Error('No bank has deposit costs at both ends of the beta window');
  values.sort((a, b) => a - b);
  const q = (p) => values[Math.floor(p * (values.length - 1))];
  return { betas, summary: { window: [iso(from), iso(to)], fedFundsChange: round(dFF, 3), banks: values.length, p25: round(q(0.25), 3), median: round(q(0.5), 3), p75: round(q(0.75), 3) } };
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) throw new Error('Singular fit');
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

const GROUPS = ['nonMortgage', 'passThrough', 'otherMortgage'];

// One observation per bank-quarter: the change in fair value over cost against
// the curve change, by bucket group, plus a pull-to-par term.
function observations(history, curves) {
  const panel = byCertAndDate(history);
  const dates = [...new Set(history.map((r) => r.REPDTE))].sort();
  const out = [];
  for (let i = 1; i < dates.length; i += 1) {
    const d0 = dates[i - 1]; const d1 = dates[i];
    const c0 = curves.get(d0); const c1 = curves.get(d1);
    if (!c0 || !c1) continue;
    for (const rows of panel.values()) {
      const a = rows.get(d0); const b = rows.get(d1);
      if (!a || !b) continue;
      const ac0 = (a.SCAA ?? 0) + (a.SCHA ?? 0); const ac1 = (b.SCAA ?? 0) + (b.SCHA ?? 0);
      const fv0 = (a.SCAF ?? 0) + (a.SCHF ?? 0); const fv1 = (b.SCAF ?? 0) + (b.SCHF ?? 0);
      if (ac0 < 10_000 || ac1 < 10_000 || Math.abs(ac1 / ac0 - 1) > 0.10) continue;
      const bucketSum = SECURITY_BUCKETS.reduce((s, bk) => s + (a[bk.field] ?? 0), 0);
      const reportedBasis = (a.SCAF ?? 0) + (a.SCHA ?? 0);
      if (!(reportedBasis > 0) || Math.abs(bucketSum / reportedBasis - 1) > 0.10) continue;
      const ex = exposures(a, SECURITY_BUCKETS, c0, c1);
      const r0 = fv0 / ac0; const r1 = fv1 / ac1;
      out.push({
        quarter: d1,
        x: [...GROUPS.map((g) => (ex[g] ?? 0) / ac0), 1 - r0],
        y: r1 - r0,
        w: ac0,
        ac1, fv1, r0,
      });
    }
  }
  return out;
}

function wls(obs) {
  const k = obs[0].x.length;
  const A = Array.from({ length: k }, () => Array(k).fill(0));
  const b = Array(k).fill(0);
  for (const o of obs) for (let i = 0; i < k; i += 1) { b[i] += o.w * o.x[i] * o.y; for (let j = 0; j < k; j += 1) A[i][j] += o.w * o.x[i] * o.x[j]; }
  const beta = solve(A, b);
  const wsum = obs.reduce((s, o) => s + o.w, 0);
  const ybar = obs.reduce((s, o) => s + o.w * o.y, 0) / wsum;
  let ssr = 0; let sst = 0;
  for (const o of obs) { const e = o.y - o.x.reduce((s, x, i) => s + x * beta[i], 0); ssr += o.w * e * e; sst += o.w * (o.y - ybar) ** 2; }
  return { beta, r2: 1 - ssr / sst, n: obs.length };
}

// Fits duration scales for the mortgage groups (non-mortgage is fitted too, as a
// check that par-bond duration describes it) and backtests out of sample.
export function fitMortgageDurations(history, curves, { trainThrough = '20241231' } = {}) {
  const obs = observations(history, curves);
  const train = obs.filter((o) => o.quarter <= trainThrough);
  const test = obs.filter((o) => o.quarter > trainThrough);
  const fit = wls(train);
  const full = wls(obs);
  const predict = (o, beta) => o.x.reduce((s, x, i) => s + x * beta[i], 0);
  const backtest = [];
  for (const quarter of [...new Set(obs.map((o) => o.quarter))].sort()) {
    const rows = obs.filter((o) => o.quarter === quarter);
    const actual = rows.reduce((s, o) => s + (o.ac1 - o.fv1), 0);
    const model = rows.reduce((s, o) => s + (o.ac1 - (o.r0 + predict(o, fit.beta)) * o.ac1), 0);
    const naive = rows.reduce((s, o) => s + (o.ac1 - o.r0 * o.ac1), 0);
    backtest.push({
      quarter: iso(quarter), sample: quarter > trainThrough ? 'test' : 'train', banks: rows.length,
      actualLoss: Math.round(actual), modelLoss: Math.round(model), noChangeLoss: Math.round(naive),
      modelError: round((model - actual) / Math.abs(actual), 4), noChangeError: round((naive - actual) / Math.abs(actual), 4),
    });
  }
  const named = (beta) => Object.fromEntries([...GROUPS, 'pullToPar'].map((g, i) => [g, round(beta[i], 4)]));
  const testRows = backtest.filter((b) => b.sample === 'test');
  const mae = (key) => round(testRows.reduce((s, b) => s + Math.abs(b[key]), 0) / Math.max(1, testRows.length), 4);
  return {
    method: 'Weighted least squares of the quarterly change in securities fair value over amortized cost on bucket-level par-duration exposures to the Treasury curve change, plus 1 - FV/AC for pull to par; weights are amortized cost',
    trainThrough: iso(trainThrough),
    coefficients: named(fit.beta),
    coefficientsAllQuarters: named(full.beta),
    r2: round(fit.r2, 4),
    observations: { train: train.length, test: test.length },
    backtest,
    outOfSample: { quarters: testRows.length, meanAbsErrorModel: mae('modelError'), meanAbsErrorNoChange: mae('noChangeError') },
  };
}

// Rate presets as per-tenor changes [[tenor, change in percentage points]].
export function presets({ treasury, fred }) {
  const at = (curves, date) => { let c = null; for (const x of curves) if (x.date <= date) c = x; return c; };
  const c2021 = at(treasury, '2021-12-31'); const c2022 = at(treasury, '2022-12-31');
  const y2022 = c2022.points.map(([t]) => [t, round(yieldAt(c2022.points, t) - yieldAt(c2021.points, t), 2)]);
  // 1981: the largest 12-month rise in the 2-year yield on record, every tenor over the same window.
  const map = [['DTB3', 0.25], ['DGS1', 1], ['DGS2', 2], ['DGS3', 3], ['DGS5', 5], ['DGS7', 7], ['DGS10', 10], ['DGS20', 20], ['DGS30', 30]];
  const window = fred.worst2y;
  const y1981 = [];
  for (const [series, tenor] of map) {
    const s = fred.series[series];
    if (!s?.length) continue;
    const a = valueOnOrBefore(s, window.from[0]); const b = valueOnOrBefore(s, window.to[0]);
    if (a && b && b[0] >= window.to[0].slice(0, 7)) y1981.push([tenor, round(b[1] - a[1], 2)]);
  }
  return {
    today: { label: 'Today', changes: [[1, 0]] },
    plus1: { label: '+1', changes: [[1, 1]] },
    y2022: { label: '2022', window: [c2021.date, c2022.date], source: 'Treasury par curve', changes: y2022 },
    y1981: { label: '1981', window: [window.from[0], window.to[0]], source: 'FRED H.15 constant maturity and 3-month bill', worst2yRise: window.rise, changes: y1981 },
  };
}

const MISSING_COST = /not performed|will provide|not available/i;

export function failureRecords(failures) {
  return failures
    .filter((f) => Number(f.FAILYR) >= 2007)
    .map((f) => {
      const cost = f.COST === null || f.COST === undefined || f.COST === '' || (Number(f.COST) === 0 && MISSING_COST.test(f.COMMENTS ?? '')) ? null : Number(f.COST);
      return { name: f.NAME, date: f.FAILDATE, state: f.PSTALP ?? null, assets: Number(f.QBFASSET ?? 0), deposits: Number(f.QBFDEP ?? 0), cost, resolution: f.RESTYPE1 ?? null };
    })
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

export const TIERS = Object.freeze([
  { id: 'under1b', max: 1_000_000 }, { id: '1to10b', max: 10_000_000 }, { id: '10to100b', max: 100_000_000 }, { id: 'over100b', max: Infinity },
]);
export const tierOf = (assets) => TIERS.find((t) => assets < t.max).id;

// FDIC loss as a share of assets at failure, 2008 on, by size tier.
export function lossRates(records) {
  const out = {};
  for (const tier of TIERS) {
    const rates = records.filter((r) => Number(r.date.split('/')[2]) >= 2008 && r.cost !== null && r.assets > 0 && tierOf(r.assets) === tier.id).map((r) => r.cost / r.assets).sort((a, b) => a - b);
    const q = (p) => (rates.length ? rates[Math.floor(p * (rates.length - 1))] : null);
    out[tier.id] = { failures: rates.length, p25: rates.length ? round(q(0.25)) : null, median: rates.length ? round(q(0.5)) : null, p75: rates.length ? round(q(0.75)) : null };
  }
  out.excludedMissingCost = records.filter((r) => r.cost === null).length;
  return out;
}

// Share of potential discount window collateral already pledged, from the Fed's
// count of banks' pledged lendable value against what the call reports could pledge.
export function readinessShare(rows, margins, curve, fit, pledgedThousands) {
  let potential = 0;
  for (const row of rows) potential += lendableValue(row, margins, curve, fit).total;
  return { pledged: pledgedThousands, potential: Math.round(potential), share: round(Math.min(1, pledgedThousands / potential), 4) };
}
