#!/usr/bin/env node
// Probe, then rebuild only what changed. Writes content-addressed files,
// manifest.json, status.json and the committed collector state into generated/.
// Exit codes: 0 published or nothing changed; 1 a gate or source failed (the last
// good publication stays and status.json says why).
//
//   node scripts/collect.mjs            probe, rebuild if anything changed
//   node scripts/collect.mjs --force    rebuild everything
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { fdicPull, fdicProbe, latestReportDate, latestValue, isoDate } from './lib/fdic.mjs';
import { treasuryYear, curveOnOrBefore, fredSeries, worstTwelveMonthRise } from './lib/rates.mjs';
import { fetchMargins } from './lib/margins.mjs';
import { downloadCallBulk, readSchedules, crossCheck } from './lib/ffiec.mjs';
import { buildBankTable } from './lib/build.mjs';
import { runGates, sodTie, districtCheck } from './lib/gates.mjs';
import * as C from './lib/calibrate.mjs';
import { lendingLabels } from './lib/labels.mjs';
import { readJsonIfExists, writeJson, writeContent } from './lib/storage.mjs';
import { runProvenance } from './lib/provenance.mjs';
import { CITATIONS, DISTRICTS } from './lib/constants.mjs';
import { canonicalJson } from './lib/canonical-json.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = path.join(ROOT, 'generated');
const read = async (rel) => JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'));
const log = (...a) => console.log(...a);

function defaultState() {
  return { schemaVersion: 1, probe: null, built: null, calibratedFor: null, publishedPaths: {}, keepalive: { lastCommittedAt: null, lastCommit: null } };
}

async function listedSet() {
  const text = await readFile(path.join(ROOT, 'config/listings/crsp_20240930v2.csv'), 'latin1');
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = header.split(',');
  const entity = cols.indexOf('entity'); const end = cols.indexOf('dt_end');
  const set = new Set();
  for (const line of lines) {
    const cells = line.split(',');
    // Names may contain commas; entity and dates are the last four numeric fields.
    const tail = cells.slice(-4);
    if (tail[3] === '20240930') set.add(tail[0]);
    void entity; void end;
  }
  const overrides = await readJsonIfExists(path.join(ROOT, 'config/listings/overrides.json'));
  for (const r of overrides?.listed ?? []) set.add(String(r.rssd));
  for (const r of overrides?.delisted ?? []) set.delete(String(r.rssd));
  return set;
}

async function probe(http) {
  const latest = await latestReportDate(http);
  const failures = await fdicProbe('failures', { field: 'CERT', http });
  const sodYear = Number((await latestValue('sod', 'YEAR', http)).value);
  if (!(sodYear >= 2020)) throw new Error('FDIC SOD latest year is missing');
  const active = await fdicPull('institutions', { filters: 'ACTIVE:1', fields: ['CERT'], sortBy: 'CERT', http });
  const activeHash = createHash('sha256').update(active.rows.map((r) => r.CERT).sort((a, b) => a - b).join(',')).digest('hex');
  return { repdte: latest.repdte, financialsIndex: latest.index.name, failuresTotal: failures.total, failuresIndex: failures.index.name, sodYear, activeCount: active.rows.length, activeHash };
}

async function curvesFor(years, http) {
  const all = [];
  for (const y of years) all.push(...await treasuryYear(y, http));
  return all.sort((a, b) => a.date.localeCompare(b.date));
}

export async function main({ force = process.argv.includes('--force'), env = process.env } = {}) {
  const startedAt = new Date().toISOString();
  const policy = await read('config/policy.json');
  const fieldsCfg = await read('config/fields.json');
  const crosswalk = await read('config/district-counties.json');
  const http = { userAgent: policy.userAgent };
  const statePath = path.join(GENERATED, 'state', 'collector-state.json');
  const state = { ...defaultState(), ...(await readJsonIfExists(statePath) ?? {}) };
  const previousManifest = await readJsonIfExists(path.join(GENERATED, 'manifest.json'));
  const run = runProvenance(env, startedAt);
  const status = { schemaVersion: 1, scheduleGuarantee: false, checkedAt: startedAt, run, outcome: 'unknown', sources: {}, gates: [], message: '' };
  const writeStatus = async () => writeJson(path.join(GENERATED, 'status.json'), status);

  let probed;
  try {
    probed = await probe(http);
    status.sources.fdic = { ok: true, ...probed };
  } catch (error) {
    status.outcome = 'failed';
    status.message = `FDIC probe failed: ${error.message}`;
    status.sources.fdic = { ok: false, error: error.message };
    await writeStatus();
    await writeJson(statePath, state);
    log(status.message);
    return 1;
  }

  const changed = !state.probe || canonicalJson({ ...state.probe }) !== canonicalJson({ ...probed });
  if (!changed && !force) {
    status.outcome = 'no-change';
    status.message = `No FDIC change since ${state.built?.at ?? 'never'} (index ${probed.financialsIndex})`;
    status.lastPublishedAt = state.built?.at ?? null;
    await writeStatus();
    log(status.message);
    return 0;
  }
  log('Change detected:', JSON.stringify({ was: state.probe, now: probed }));

  try {
    const fields = Object.values(fieldsCfg.financials).flat();
    const fin = await fdicPull('financials', { filters: `REPDTE:${probed.repdte}`, fields, sortBy: 'CERT', http });
    if (fin.index.name !== probed.financialsIndex) throw new Error('FDIC financials index moved between probe and pull; retry next run');
    const inst = await fdicPull('institutions', { fields: fieldsCfg.institutions, sortBy: 'CERT', http });
    const sod = await fdicPull('sod', { filters: `YEAR:${probed.sodYear}`, fields: fieldsCfg.sod, sortBy: 'CERT', http });
    const failures = await fdicPull('failures', { fields: fieldsCfg.failures, sortBy: 'CERT', http });
    const june = await fdicPull('financials', { filters: `REPDTE:${probed.sodYear}0630`, fields: ['CERT', 'REPDTE', 'DEPDOM'], sortBy: 'CERT', http });
    log(`FDIC: ${fin.rows.length} filings, ${inst.rows.length} institutions, ${sod.rows.length} branches, ${failures.rows.length} failures`);

    // Calibration reruns only for a new filing date (or when missing).
    const nowYear = new Date().getUTCFullYear();
    const treasury = await curvesFor(Array.from({ length: nowYear - 2020 }, (_, i) => 2021 + i), http);
    let calibration = state.calibratedFor === probed.repdte && previousManifest ? await previousContent(previousManifest, 'calibration') : null;
    const margins = await fetchMargins(http);
    if (!calibration) {
      log('Calibrating...');
      const history = await fdicPull('financials', { filters: `REPDTE:[${policy.historyFrom} TO ${probed.repdte}]`, fields: fieldsCfg.history, sortBy: 'CERT', http });
      const curves = new Map();
      for (const d of new Set(history.rows.map((r) => r.REPDTE))) curves.set(d, curveOnOrBefore(treasury, isoDate(d)).points);
      const fit = C.fitMortgageDurations(history.rows, curves, { trainThrough: policy.durationTrainThrough });
      const fred = await fredSeries(['DFF'], http);
      const betas = C.depositBetas(history.rows, C.quarterlyAverages(fred.DFF), policy.betaWindow);
      const long = await fredSeries(['DTB3', 'DGS1', 'DGS2', 'DGS3', 'DGS5', 'DGS7', 'DGS10', 'DGS20', 'DGS30'], http);
      const presetTable = C.presets({ treasury, fred: { series: long, worst2y: worstTwelveMonthRise(long.DGS2) } });
      const ready = await fdicPull('financials', { filters: `REPDTE:${policy.readiness.reportDate}`, fields, sortBy: 'CERT', http });
      const readyRows = ready.rows.filter((r) => r.EQ !== null && r.EQ !== undefined && r.DEP > 0);
      const readyCurve = curveOnOrBefore(treasury, policy.readiness.asOf).points;
      const share = C.readinessShare(readyRows, margins, readyCurve, fit.coefficients, policy.readiness.pledgedLendableBanksThousands);
      const inst23 = policy.readiness.institutionsLendableThousands;
      const scale = policy.readiness.pledgedLendableBanksThousands / inst23.total;
      let potSec = 0; let potLoans = 0;
      const { lendableValue } = await import('./lib/core/lendable.mjs');
      for (const r of readyRows) { const v = lendableValue(r, margins, readyCurve, fit.coefficients); potSec += v.securities; potLoans += v.loans; }
      calibration = {
        schemaVersion: 1,
        kind: 'calibration',
        reportDate: isoDate(probed.repdte),
        mortgageDuration: fit,
        depositBeta: { ...betas.summary, method: 'Change in annualized domestic deposit interest expense over average domestic deposits, divided by the change in the quarterly average effective fed funds rate (FRED DFF); clamped to 0 to 1.2' },
        presets: presetTable,
        readiness: {
          ...policy.readiness,
          potentialThousands: share.potential,
          share: share.share,
          securitiesShare: Number(Math.min(1, (inst23.securities * scale) / potSec).toFixed(4)),
          loansShare: Number(Math.min(1, (inst23.loans * scale) / potLoans).toFixed(4)),
          method: 'Banks\' pledged lendable value (Fed) over the lendable value their Dec 31, 2023 call reports could support at current margins; the securities and loans split follows the Fed\'s institution totals',
        },
      };
      state.calibratedFor = probed.repdte;
    }
    // Betas join the bank table by certificate before identifiers are dropped; they
    // are never published keyed by certificate. Four quarters cover the window.
    const w = policy.betaWindow;
    const prev = (d) => (d.slice(4) === '1231' ? `${d.slice(0, 4)}0930` : null);
    const betaRows = await fdicPull('financials', { filters: `REPDTE:(${[prev(w.from), w.from, prev(w.to), w.to].join(' OR ')})`, fields: ['CERT', 'REPDTE', 'DEPDOM', 'EDEPDOMQ'], sortBy: 'CERT', http });
    const effrBeta = C.quarterlyAverages((await fredSeries(['DFF'], http)).DFF);
    const betaMap = C.depositBetas(betaRows.rows, effrBeta, w).betas;

    const listed = await listedSet();
    const failureRecs = C.failureRecords(failures.rows);
    const { table } = buildBankTable({ reportDate: isoDate(probed.repdte), fdicIndex: fin.index.name, financials: fin.rows, institutions: inst.rows, sod: sod.rows, listedRssd: listed, extra: { beta: betaMap } });
    table.sodYear = probed.sodYear;
    table.districts = DISTRICTS;

    // Independent copy of the filings.
    let cross = null;
    try {
      const period = `${probed.repdte.slice(4, 6)}/${probed.repdte.slice(6, 8)}/${probed.repdte.slice(0, 4)}`;
      const zip = await downloadCallBulk(period, http);
      cross = crossCheck(fin.rows, readSchedules(zip, ['POR', 'Schedule RC ', 'Schedule RCB', 'Schedule RCO']), fieldsCfg.ffiecCrossCheck);
      status.sources.ffiec = { ok: true, linked: cross.linked };
    } catch (error) {
      status.sources.ffiec = { ok: false, error: error.message };
    }

    const previousBanks = previousManifest ? await previousContent(previousManifest, 'banks') : null;
    const previousStats = previousManifest?.stats ?? null;
    const gates = runGates({
      fields,
      financials: fin.rows,
      table,
      previous: previousStats,
      crossCheck: cross,
      sodTie: sodTie(june.rows, sod.rows, probed.sodYear, policy.gates.sodTieTolerance),
      districtCheck: districtCheck(inst.rows, crosswalk),
      fit: calibration.mortgageDuration,
      policy,
    });
    status.gates = gates.results;
    void previousBanks;
    if (!gates.pass) {
      status.outcome = 'failed';
      status.message = `Gates failed: ${gates.results.filter((r) => !r.pass).map((r) => `${r.id} (${r.detail})`).join('; ')}`;
      await writeStatus();
      await writeJson(statePath, state);
      log(status.message);
      return 1;
    }

    // Replays are frozen after the first successful build.
    const replayEntries = [];
    let labels = null;
    for (const replay of policy.replays) {
      const existing = previousManifest?.files?.find((f) => f.id === `replay:${replay.id}` && f.version === policy.replayVersion);
      if (existing) { replayEntries.push(existing); continue; }
      log(`Building replay ${replay.id}...`);
      const rf = await fdicPull('financials', { filters: `REPDTE:${replay.reportDate}`, fields, sortBy: 'CERT', http });
      const rsodYear = Number(replay.reportDate.slice(0, 4)) - (Number(replay.reportDate.slice(4, 6)) < 6 ? 1 : 0);
      const rsod = await fdicPull('sod', { filters: `YEAR:${rsodYear}`, fields: fieldsCfg.sod, sortBy: 'CERT', http });
      const cutoff = new Date(Date.parse(isoDate(replay.reportDate)) + replay.nameFailuresWithinMonths * 30.44 * 86_400_000);
      const names = new Map();
      for (const f of failures.rows) {
        const [m, d, y] = String(f.FAILDATE).split('/').map(Number);
        const when = new Date(Date.UTC(y, m - 1, d));
        if (when > new Date(Date.parse(isoDate(replay.reportDate))) && when <= cutoff) names.set(Number(f.CERT), `${f.NAME} (failed ${f.FAILDATE})`);
      }
      let extra = { beta: betaMap };
      if (replay.labels) {
        labels ??= await lendingLabels(http);
        const btfp = new Map();
        for (const i of inst.rows) { const amount = labels.btfpRssd.get(String(i.FED_RSSD)); if (amount) btfp.set(Number(i.CERT), Math.round(amount / 1000)); }
        const dw = new Map([...labels.dwCert].map(([c, a]) => [c, Math.round(a / 1000)]));
        extra = { ...extra, btfp, dw };
      }
      const { table: rt } = buildBankTable({ reportDate: isoDate(replay.reportDate), fdicIndex: rf.index.name, financials: rf.rows, institutions: inst.rows, sod: rsod.rows, listedRssd: listed, failedNames: names, activeOnly: false, extra });
      if (replay.labels) rt.labels = { ...labels.summary, source: CITATIONS.lending, note: 'btfp and dw columns: thousands of dollars borrowed in the window; validation only, never a model input' };
      rt.kind = 'replay';
      rt.replay = replay.id;
      rt.curveDate = replay.curveDate;
      rt.sodYear = rsodYear;
      const written = await writeContent(GENERATED, 'replays', rt);
      replayEntries.push({ id: `replay:${replay.id}`, ...written, reportDate: rt.reportDate, version: policy.replayVersion });
    }

    // Curves: every quarter end used, the replay dates and the latest day.
    const wanted = new Set([isoDate(probed.repdte), policy.readiness.asOf, ...policy.replays.map((r) => isoDate(r.reportDate)), ...policy.replays.map((r) => r.curveDate)]);
    const replayYears = [...new Set(policy.replays.flatMap((r) => [Number(r.reportDate.slice(0, 4)), Number(r.curveDate.slice(0, 4))]))].filter((y) => y < 2021);
    const early = replayYears.length ? await curvesFor(replayYears, http) : [];
    const all = [...early, ...treasury];
    const curves = {
      schemaVersion: 1,
      kind: 'curves',
      source: CITATIONS.treasury,
      latest: all[all.length - 1],
      onOrBefore: Object.fromEntries([...wanted].map((d) => [d, curveOnOrBefore(all, d)])),
      presets: calibration.presets,
    };

    const failuresContent = { schemaVersion: 1, kind: 'failures', source: CITATIONS.fdic, records: failureRecs, lossRates: C.lossRates(failureRecs) };
    calibration.margins = margins;
    calibration.lossRates = failuresContent.lossRates;

    const entries = [
      { id: 'banks', ...(await writeContent(GENERATED, 'banks', table)), reportDate: table.reportDate, count: table.count },
      { id: 'curves', ...(await writeContent(GENERATED, 'curves', curves)), latest: curves.latest.date },
      { id: 'calibration', ...(await writeContent(GENERATED, 'calibration', calibration)) },
      { id: 'failures', ...(await writeContent(GENERATED, 'failures', failuresContent)), count: failureRecs.length },
      ...replayEntries,
    ];
    const manifest = {
      schemaVersion: 1,
      scheduleGuarantee: false,
      generatedAt: new Date().toISOString(),
      reportDate: table.reportDate,
      fdicIndex: fin.index.name,
      sodYear: probed.sodYear,
      run,
      citations: CITATIONS,
      stats: { totals: gates.totals, blankRates: gates.blankRates, excluded: table.excluded },
      gates: gates.results,
      files: entries,
    };
    await writeJson(path.join(GENERATED, 'manifest.json'), manifest);
    for (const e of entries) state.publishedPaths[e.id] = [...new Set([e.path, ...(state.publishedPaths[e.id] ?? [])])].slice(0, 2);
    state.probe = probed;
    state.built = { at: manifest.generatedAt, reportDate: table.reportDate, fdicIndex: fin.index.name };
    status.outcome = 'published';
    status.message = `Published ${table.count} banks filed ${table.reportDate}`;
    status.lastPublishedAt = manifest.generatedAt;
    await writeStatus();
    await writeJson(statePath, state);
    log(status.message);
    return 0;
  } catch (error) {
    status.outcome = 'failed';
    status.message = `Rebuild failed: ${error.message}`;
    await writeStatus();
    await writeJson(statePath, state);
    log(status.message);
    if (process.env.DEBUG) console.error(error);
    return 1;
  }
}

async function previousContent(manifest, id) {
  const entry = manifest.files?.find((f) => f.id === id);
  return entry ? readJsonIfExists(path.join(GENERATED, entry.path)) : null;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
