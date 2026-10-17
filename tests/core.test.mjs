import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yieldAt, parDuration, shiftCurve, parallel } from '../scripts/lib/core/curve.mjs';
import { markChange, securitiesLossOn, SECURITY_BUCKETS, LOAN_BUCKETS } from '../scripts/lib/core/marks.mjs';
import { lendableValue } from '../scripts/lib/core/lendable.mjs';
import { parseMargins } from '../scripts/lib/margins.mjs';
import { readFileSync } from 'node:fs';

const curve = [[0.25, 4], [2, 4.5], [10, 5], [30, 5.5]];

test('yieldAt interpolates linearly and is flat past the ends', () => {
  assert.equal(yieldAt(curve, 0.1), 4);
  assert.equal(yieldAt(curve, 6), 4.75);
  assert.equal(yieldAt(curve, 40), 5.5);
});

test('parDuration matches the closed form for a 10-year par bond at 5%', () => {
  // (1 - 1.025^-20) / 0.05 = 7.7946
  assert.ok(Math.abs(parDuration(10, 5) - 7.7946) < 1e-3);
  assert.ok(parDuration(0.125, 4) < 0.13);
});

test('curve shifts', () => {
  assert.deepEqual(parallel([[1, 4]], 1), [[1, 5]]);
  assert.deepEqual(shiftCurve([[1, 4], [10, 5]], [[1, 2], [10, 1]]), [[1, 6], [10, 6]]);
});

test('marks are zero on an unchanged curve and negative when rates rise', () => {
  const row = { SCNM5T15: 1000, SCPTOV15: 2000, LNRS5T15: 500, SCAA: 3000, SCAF: 2900, SCHA: 0, SCHF: 0 };
  assert.deepEqual(markChange(row, curve, curve, null), { securities: 0, loans: 0 });
  const up = parallel(curve, 1);
  const m = markChange(row, curve, up, { nonMortgage: 1, passThrough: 0.5, otherMortgage: 1 });
  assert.ok(m.securities < 0 && m.loans < 0);
  assert.ok(securitiesLossOn(row, curve, up, null) > 100);
});

test('bucket tables cover the call report schedules exactly once', () => {
  const fields = [...SECURITY_BUCKETS, ...LOAN_BUCKETS].map((b) => b.field);
  assert.equal(new Set(fields).size, fields.length);
  assert.equal(SECURITY_BUCKETS.length, 14);
  assert.equal(LOAN_BUCKETS.length, 12);
});

test('lendable value applies margins below 100% and never exceeds collateral', () => {
  const margins = parseMargins(readFileSync(new URL('./fixtures/margins.html', import.meta.url), 'utf8'));
  const row = {
    ASSET: 1_000_000, SCAA: 200_000, SCAF: 190_000, SCHA: 0, SCHF: 0, SCPLEDGE: 0,
    SCUST: 100_000, SCAGE: 0, SCMTGBK: 100_000, SCRMBPI: 0, SCCMOS: 0, SCMUNI: 0,
    SCNM1T3: 95_000, SCPTOV15: 95_000, LNLSGR: 600_000, OTHBFHLB: 0,
    LNRS5T15: 300_000, LNOT1T3: 300_000, LNRENRES: 100_000, LNREMULT: 0, LNRECONS: 0,
  };
  const v = lendableValue(row, margins, curve, null);
  assert.ok(v.securities > 0.9 * 190_000 && v.securities < 190_000);
  assert.ok(v.loans > 0.5 * 600_000 && v.loans < 600_000);
  assert.equal(v.scope, 'out');
});
