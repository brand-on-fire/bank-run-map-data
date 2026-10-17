// Labels for the 2023 replay: did the bank borrow from the Bank Term Funding Program
// or the discount window between the first runs and the end of May 2023? Used only
// to test the model out of sample; never an input to it.
import { fetchOk } from './http.mjs';
import { frbFileUrl } from './urls.mjs';
import { readSheet, excelDate } from './xlsx.mjs';
import { downloadCallBulk, readSchedules } from './ffiec.mjs';

export const WINDOW = Object.freeze({ from: '2023-03-09', to: '2023-05-31' });

async function sheet(id, http) {
  const res = await fetchOk(frbFileUrl(id), { ...http, maxBytes: 20_000_000, timeoutMs: 120_000 });
  return readSheet(res.buffer, 1);
}

function table(rows, firstHeader) {
  const h = rows.findIndex((r) => r.A === firstHeader);
  if (h < 0) throw new Error(`No header row starting "${firstHeader}"`);
  const header = rows[h];
  const cols = Object.fromEntries(Object.entries(header).filter(([, v]) => v).map(([k, v]) => [String(v).trim(), k]));
  return { cols, data: rows.slice(h + 1).filter((r) => r.A) };
}

export async function lendingLabels(http) {
  // BTFP borrowers by RSSD.
  const btfp = table(await sheet('btfp', http), 'Date Of Advance');
  const btfpRssd = new Map();
  for (const r of btfp.data) {
    const date = excelDate(r[btfp.cols['Date Of Advance']]);
    if (!date || date < WINDOW.from || date > WINDOW.to) continue;
    const rssd = String(r[btfp.cols['Borrower RSSD']] ?? '').trim();
    btfpRssd.set(rssd, (btfpRssd.get(rssd) ?? 0) + Number(r[btfp.cols['Advance Amount']] ?? 0));
  }
  // Discount window borrowers by ABA routing number (primary credit only).
  const dwAba = new Map();
  for (const id of ['dw2023q1', 'dw2023q2']) {
    const dw = table(await sheet(id, http), 'Loan date');
    for (const r of dw.data) {
      const date = excelDate(r[dw.cols['Loan date']]);
      if (!date || date < WINDOW.from || date > WINDOW.to) continue;
      if (!/primary/i.test(String(r[dw.cols['Type of credit']] ?? ''))) continue;
      const aba = String(r[dw.cols['Borrower ABA number']] ?? '').trim().padStart(9, '0');
      dwAba.set(aba, (dwAba.get(aba) ?? 0) + Number(r[dw.cols['Loan amount']] ?? 0));
    }
  }
  // ABA to FDIC certificate from the Dec 31, 2022 filings (FFIEC POR file).
  const por = readSchedules(await downloadCallBulk('12/31/2022', http), ['POR']).POR;
  const abaToCert = new Map();
  for (const rec of por.values()) {
    const aba = String(rec['Primary ABA Routing Number'] ?? '').trim().padStart(9, '0');
    if (aba !== '000000000') abaToCert.set(aba, Number(rec['FDIC Certificate Number']));
  }
  const dwCert = new Map();
  let unmatched = 0;
  for (const [aba, amount] of dwAba) { const c = abaToCert.get(aba); if (c) dwCert.set(c, (dwCert.get(c) ?? 0) + amount); else unmatched += 1; }
  return { btfpRssd, dwCert, summary: { window: WINDOW, btfpBorrowers: btfpRssd.size, dwBorrowers: dwAba.size, dwMatched: dwCert.size, dwUnmatched: unmatched } };
}
