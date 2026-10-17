// Assembles the published bank table for one filing date from raw FDIC pulls.
// Rows are keyed by position only: no names or certificate numbers are published
// for the current quarter (replays name only banks that later failed).

export class BuildError extends Error {
  constructor(message) { super(message); this.name = 'BuildError'; }
}

// Published amount columns, in FDIC thousands, rounded to the nearest 100 ($0.1M).
export const AMOUNT_COLUMNS = Object.freeze([
  'ASSET', 'DEP', 'DEPDOM', 'DEPINS', 'DEPUNINS', 'DEPLGAMT', 'DEPNIDOM', 'BRO',
  'CHBAL', 'CHFRB', 'FREPO', 'SCAA', 'SCAF', 'SCHA', 'SCHF', 'SCPLEDGE', 'LNPLEDGE',
  'SCUST', 'SCAGE', 'SCMTGBK', 'SCRMBPI', 'SCCMOS',
  'SCNM3LES', 'SCNM3T12', 'SCNM1T3', 'SCNM3T5', 'SCNM5T15', 'SCNMOV15',
  'SCPT3LES', 'SCPT3T12', 'SCPT1T3', 'SCPT3T5', 'SCPT5T15', 'SCPTOV15', 'SCO3YLES', 'SCOOV3Y',
  'LNLSGR', 'LNLSNET', 'LNRENRES', 'LNREMULT', 'LNRECONS',
  'LNRS3LES', 'LNRS3T12', 'LNRS1T3', 'LNRS3T5', 'LNRS5T15', 'LNRSOV15',
  'LNOT3LES', 'LNOT3T12', 'LNOT1T3', 'LNOT3T5', 'LNOT5T15', 'LNOTOV15',
  'OTHBFHLB', 'OTHBRF', 'FREPP', 'EQ', 'EQCCOMPI', 'INTAN', 'RTNVS',
  'EDEPDOMQ', 'NONIXQ', 'ILNDOMQ',
]);
export const COUNT_COLUMNS = Object.freeze(['DEPLGB']);
export const RATIO_COLUMNS = Object.freeze(['IDT1CER', 'RBC1AAJ']);

const round100 = (v) => (v === null || v === undefined ? null : Math.round(v / 100) * 100);
const round2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
const round1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

// Which rows count as operating insured banks on the filing date.
export function universe(financials, institutions) {
  const byCert = new Map(institutions.map((row) => [Number(row.CERT), row]));
  const kept = [];
  const excluded = { noDepositsOrEquity: 0, noInstitutionRecord: 0, closedOrMergedSinceFiling: 0, noLocation: 0 };
  for (const row of financials) {
    const inst = byCert.get(Number(row.CERT));
    if (row.EQ === null || row.EQ === undefined || !(row.DEP > 0)) { excluded.noDepositsOrEquity += 1; continue; }
    if (!inst) { excluded.noInstitutionRecord += 1; continue; }
    kept.push({ fin: row, inst });
  }
  return { kept, excluded };
}

// SOD branch deposits by state for each certificate.
export function footprints(sodRows) {
  const byCert = new Map();
  for (const row of sodRows) {
    const cert = Number(row.CERT);
    const state = row.STALPBR;
    const deposits = Number(row.DEPSUMBR ?? 0);
    if (!state || !Number.isFinite(deposits)) continue;
    const map = byCert.get(cert) ?? new Map();
    map.set(state, (map.get(state) ?? 0) + deposits);
    byCert.set(cert, map);
  }
  return byCert;
}

export function buildBankTable({ reportDate, fdicIndex, financials, institutions, sod, listedRssd, failedNames = null, activeOnly = true, extra = {} }) {
  const { kept, excluded } = universe(financials, institutions);
  const rows = [];
  for (const entry of kept) {
    if (activeOnly && Number(entry.inst.ACTIVE) !== 1) { excluded.closedOrMergedSinceFiling += 1; continue; }
    const lat = Number(entry.inst.LATITUDE);
    const lon = Number(entry.inst.LONGITUDE);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) { excluded.noLocation += 1; continue; }
    rows.push(entry);
  }
  // Stable order: district, then state, then deposits descending (no identifiers needed).
  rows.sort((a, b) => (String(a.inst.FED).localeCompare(String(b.inst.FED)))
    || String(a.inst.STALP).localeCompare(String(b.inst.STALP))
    || (b.fin.DEP - a.fin.DEP)
    || (Number(a.fin.CERT) - Number(b.fin.CERT)));
  const fp = footprints(sod);
  const columns = {
    district: [], state: [], lat: [], lon: [], listed: [], footprint: [],
    ...Object.fromEntries([...AMOUNT_COLUMNS, ...COUNT_COLUMNS, ...RATIO_COLUMNS].map((c) => [c, []])),
    ...Object.fromEntries(Object.keys(extra).map((c) => [c, []])),
  };
  const names = [];
  const certs = [];
  for (const { fin, inst } of rows) {
    const district = Number(inst.FED);
    if (!(district >= 1 && district <= 12)) throw new BuildError(`Bank with FED ${inst.FED} has no valid district`);
    columns.district.push(district);
    columns.state.push(inst.STALP);
    columns.lat.push(round1(Number(inst.LATITUDE)));
    columns.lon.push(round1(Number(inst.LONGITUDE)));
    const rssds = [String(inst.FED_RSSD ?? ''), String(inst.RSSDHCR ?? '')].filter((r) => r && r !== '0');
    columns.listed.push(rssds.some((r) => listedRssd.has(r)) ? 1 : 0);
    const states = fp.get(Number(fin.CERT));
    columns.footprint.push(states ? [...states].sort((a, b) => b[1] - a[1]).map(([s, d]) => [s, round100(d)]) : [[inst.STALP, round100(fin.DEPDOM ?? fin.DEP)]]);
    for (const c of AMOUNT_COLUMNS) columns[c].push(round100(fin[c] ?? null));
    for (const c of COUNT_COLUMNS) columns[c].push(fin[c] ?? null);
    for (const c of RATIO_COLUMNS) columns[c].push(round2(fin[c] ?? null));
    for (const [c, values] of Object.entries(extra)) columns[c].push(values.get(Number(fin.CERT)) ?? null);
    names.push(failedNames?.get(Number(fin.CERT)) ?? null);
    certs.push(Number(fin.CERT));
  }
  const table = {
    schemaVersion: 1,
    kind: 'banks',
    reportDate,
    fdicIndex,
    units: 'Amounts in thousands of U.S. dollars rounded to the nearest 100; ratios in percent',
    count: rows.length,
    excluded,
    columns,
  };
  if (failedNames) table.names = names;
  return { table, certs };
}

export function blankRates(table) {
  const out = {};
  for (const [name, values] of Object.entries(table.columns)) {
    if (!Array.isArray(values) || name === 'footprint') continue;
    out[name] = Number((values.filter((v) => v === null).length / values.length).toFixed(4));
  }
  return out;
}

export function totals(table) {
  const sum = (c) => table.columns[c].reduce((s, v) => s + (v ?? 0), 0);
  return {
    banks: table.count,
    assets: sum('ASSET'),
    deposits: sum('DEP'),
    uninsured: sum('DEPUNINS'),
    equity: sum('EQ'),
    unrealizedAfs: sum('SCAA') - sum('SCAF'),
    unrealizedHtm: sum('SCHA') - sum('SCHF'),
  };
}
