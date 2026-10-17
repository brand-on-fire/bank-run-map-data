import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { parseTreasuryCsv, parseFredCsv, worstTwelveMonthRise } from '../scripts/lib/rates.mjs';
import { fdicUrl, treasuryCurveUrl, assertRequestAllowed } from '../scripts/lib/urls.mjs';
import { buildBankTable, totals, blankRates } from '../scripts/lib/build.mjs';
import { runGates, sodTie, districtCheck } from '../scripts/lib/gates.mjs';
import { failureRecords, lossRates, depositBetas, quarterlyAverages } from '../scripts/lib/calibrate.mjs';
import { listZip, readZipEntry } from '../scripts/lib/zip.mjs';
import { crossCheck } from '../scripts/lib/ffiec.mjs';

test('request guard allows only the named hosts and paths', () => {
  assert.doesNotThrow(() => assertRequestAllowed(fdicUrl('financials', { fields: ['CERT'] })));
  assert.doesNotThrow(() => assertRequestAllowed(treasuryCurveUrl(2026)));
  assert.throws(() => assertRequestAllowed('https://api.fdic.gov/banks/other?x=1'));
  assert.throws(() => assertRequestAllowed('https://example.com/'));
  assert.throws(() => assertRequestAllowed('http://api.fdic.gov/banks/financials'));
  assert.throws(() => fdicUrl('financials', { fields: ['cert'] }));
});

test('Treasury CSV parses, sorts and rejects unknown tenors', () => {
  const csv = 'Date,"1 Mo","3 Mo","1 Yr","2 Yr","5 Yr","10 Yr","30 Yr"\n10/16/2026,4.12,4.26,4.46,4.74,4.89,5.09,5.43\n10/15/2026,4.17,4.28,4.49,4.77,4.91,5.10,5.43\n';
  const rows = parseTreasuryCsv(csv);
  assert.equal(rows[0].date, '2026-10-15');
  assert.deepEqual(rows[1].points.find(([t]) => t === 10), [10, 5.09]);
  assert.throws(() => parseTreasuryCsv('Date,"9 Mo"\n10/16/2026,1\n'));
});

test('FRED CSV and the 12-month rise', () => {
  const s = parseFredCsv('observation_date,DGS2\n1980-07-21,8.93\n1981-01-02,13.0\n1981-07-21,16.00\n1981-07-22,.\n', ['DGS2']);
  assert.equal(s.DGS2.length, 3);
  const w = worstTwelveMonthRise(s.DGS2);
  assert.equal(w.rise, 7.07);
});

const inst = (cert, extra = {}) => ({ CERT: cert, ACTIVE: 1, FED: '05', STALP: 'VA', LATITUDE: 37.54, LONGITUDE: -77.43, FED_RSSD: String(cert * 10), RSSDHCR: '0', STCNTY: '51760', ...extra });
const fin = (cert, extra = {}) => ({ CERT: cert, REPDTE: '20260630', DEP: 1_000_000, DEPDOM: 1_000_000, EQ: 100_000, ASSET: 1_200_000, SCAA: 300_000, SCAF: 280_000, SCHA: 100_000, SCHF: 90_000, DEPUNINS: 300_000, ...extra });

test('universe drops banks without deposits or equity, closed banks and unlocated banks', () => {
  const { table, certs } = buildBankTable({
    reportDate: '2026-06-30', fdicIndex: 'x',
    financials: [fin(1), fin(2, { DEP: 0 }), fin(3, { EQ: null }), fin(4), fin(5)],
    institutions: [inst(1), inst(2), inst(3), inst(4, { ACTIVE: 0 }), inst(5, { LATITUDE: 0, LONGITUDE: 0 })],
    sod: [{ CERT: 1, DEPSUMBR: 600_000, STALPBR: 'VA' }, { CERT: 1, DEPSUMBR: 400_000, STALPBR: 'NC' }],
    listedRssd: new Set(['10']),
  });
  assert.equal(table.count, 1);
  assert.deepEqual(certs, [1]);
  assert.deepEqual(table.excluded, { noDepositsOrEquity: 2, noInstitutionRecord: 0, closedOrMergedSinceFiling: 1, noLocation: 1 });
  assert.deepEqual(table.columns.footprint[0], [['VA', 600_000], ['NC', 400_000]]);
  assert.equal(table.columns.listed[0], 1);
  assert.equal(table.names, undefined, 'current tables publish no names');
  assert.equal(totals(table).unrealizedAfs, 20_000);
});

test('gates fail closed on a missing field, a count jump or a failed cross-check', () => {
  const policy = { gates: { bankCountMaxChange: 0.03, blankRateMaxDrift: 0.05, totalsMaxQuarterChange: { assets: 0.1 }, sodTieShare: 0.97, sodTieTolerance: 0.02, durationOutOfSampleMaxError: 0.1 } };
  const { table } = buildBankTable({ reportDate: 'd', fdicIndex: 'x', financials: [fin(1)], institutions: [inst(1)], sod: [], listedRssd: new Set() });
  const ok = { pass: true, fields: {} };
  const base = { fields: ['CERT'], financials: [fin(1)], table, crossCheck: ok, sodTie: { share: 1, compared: 1, year: 2026 }, districtCheck: { matched: 1, mismatches: 0, skipped: 0 }, fit: null, policy };
  const prev = { totals: { banks: 1, assets: 1_200_000, deposits: 1_000_000, equity: 100_000 }, blankRates: blankRates(table) };
  assert.equal(runGates({ ...base, previous: prev }).pass, true);
  assert.equal(runGates({ ...base, previous: prev, fields: ['CERT', 'NOPE'] }).pass, false);
  assert.equal(runGates({ ...base, previous: { ...prev, totals: { ...prev.totals, banks: 2 } } }).pass, false);
  assert.equal(runGates({ ...base, previous: prev, crossCheck: null }).pass, false);
  assert.equal(runGates({ ...base, previous: prev, districtCheck: { matched: 0, mismatches: 1, skipped: 0 } }).pass, false);
});

test('SOD tie and district check', () => {
  const tie = sodTie([fin(1), fin(2)], [{ CERT: 1, DEPSUMBR: 1_000_000 }, { CERT: 2, DEPSUMBR: 500_000 }], 2026, 0.02);
  assert.deepEqual([tie.compared, tie.within], [2, 1]);
  const d = districtCheck([inst(1), inst(2, { FED: '04' }), inst(3, { STCNTY: '09110' })], { counties: { 51760: '05' } });
  assert.deepEqual([d.matched, d.mismatches, d.skipped], [1, 1, 1]);
});

test('failure costs: a zero with "LCT not performed" is missing, not zero', () => {
  const recs = failureRecords([
    { NAME: 'A', FAILYR: '2023', FAILDATE: '3/12/2023', QBFASSET: 100, COST: 0, COMMENTS: 'LCT not performed. DRR will provide data when available.' },
    { NAME: 'B', FAILYR: '2010', FAILDATE: '1/8/2010', QBFASSET: 100, COST: 20, COMMENTS: '' },
    { NAME: 'C', FAILYR: '2008', FAILDATE: '9/25/2008', QBFASSET: 300_000_000, COST: 0, COMMENTS: '' },
  ]);
  assert.equal(recs.find((r) => r.name === 'A').cost, null);
  assert.equal(recs.find((r) => r.name === 'C').cost, 0);
  const rates = lossRates(recs);
  assert.equal(rates.under1b.median, 0.2);
  assert.equal(rates.excludedMissingCost, 1);
});

test('deposit beta is the cost change over the fed funds change', () => {
  const history = [
    { CERT: 1, REPDTE: '20210930', DEPDOM: 1000, EDEPDOMQ: 0.5 },
    { CERT: 1, REPDTE: '20211231', DEPDOM: 1000, EDEPDOMQ: 0.5 },
    { CERT: 1, REPDTE: '20230930', DEPDOM: 1000, EDEPDOMQ: 5 },
    { CERT: 1, REPDTE: '20231231', DEPDOM: 1000, EDEPDOMQ: 5.25 },
  ];
  const effr = quarterlyAverages([['2021-11-01', 0.08], ['2023-11-01', 5.33]]);
  const { betas } = depositBetas(history, effr);
  // (4*5.25/1000 - 4*0.5/1000)*100 = 1.9 points over 5.25 points
  assert.equal(betas.get(1), Number((1.9 / 5.25).toFixed(3)));
});

function makeZip(name, data) {
  const raw = deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const crc = crc32(data) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, nameBuf, raw]);
  const cd = Buffer.concat([central, nameBuf]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, end]);
}

test('zip reader inflates and CRC-checks; cross-check compares field by field', () => {
  const zip = makeZip('Schedule RC 06302026.txt', Buffer.from('"IDRSSD"\tRCON2170\n\tTOTAL ASSETS\n10\t1200\n'));
  const [entry] = listZip(zip);
  assert.equal(readZipEntry(zip, entry).toString(), '"IDRSSD"\tRCON2170\n\tTOTAL ASSETS\n10\t1200\n');
  const tables = { POR: new Map([['10', { 'FDIC Certificate Number': '1' }]]), 'Schedule RC ': new Map([['10', { RCON2170: '1200000' }]]) };
  const spec = { minExactShare: 0.97, maxAggregateGap: 0.005, fields: { ASSET: { schedule: 'Schedule RC ', codes: ['2170'] } } };
  assert.equal(crossCheck([fin(1)], tables, spec).pass, true);
  assert.equal(crossCheck([fin(1, { ASSET: 1_300_000 })], tables, spec).pass, false);
});
