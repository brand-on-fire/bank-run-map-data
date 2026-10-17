# bank-run-map-data

Public data pipeline for the Bank Run Map on projects.brandonernst.com. It publishes a validated, versioned snapshot of every FDIC-insured bank's balance sheet with the calibrations the map's model uses. Code is on `main`; output is on the append-only `public-data` branch.

## Sources

| Source | Used for |
|---|---|
| FDIC BankFind Suite API: financials, institutions, Summary of Deposits, failures | Balance sheets, locations, Fed district, branch deposits by state, failure costs |
| FFIEC CDR bulk call reports | Independent cross-check of 9 FDIC fields, bank by bank |
| U.S. Treasury daily par yield curve | Marks between filings; 2022 rate preset |
| FRED H.15 (DFF, DTB3, DGS1 to DGS30) | Deposit betas; 1981 rate preset |
| Federal Reserve discount window margins | Lendable value of collateral |
| Board of Governors, *Federal Reserve District Boundaries* (1996) and Census 2020 counties | District outlines |
| NY Fed CRSP-FRB link (Sept 30, 2024) | Publicly traded flag |

Bank names and FDIC certificate numbers are not published for the current quarter. Replays name only banks that failed within 24 months of the filing date.

## Schedule and cost

One workflow. It runs daily in Feb, May, Aug and Nov and on days 1 to 15 of the following month, and weekly otherwise. The probe makes a handful of small requests and exits when FDIC reports no change. A rebuild runs only when the filing index, failure count, branch-deposit year or roster of active banks changes. There are no secrets, caches or paid services.

## Gates

Nothing is published unless every gate passes; the last good publication stays live and `status.json` says why.

1. Every requested FDIC field present.
2. Bank count within 3% of the last publication.
3. Each field's blank rate within 5 points of its recorded band.
4. System assets and deposits within 10% of the last publication, equity within 15%.
5. FFIEC cross-check: at least 97% of banks match exactly on each field and totals within 0.5%.
6. Branch deposits tie to call report domestic deposits for at least 97% of banks (within 2%).
7. Every bank's FDIC district matches the county crosswalk.
8. The mortgage-duration fit beats a no-change forecast out of sample, with mean absolute error of 10% or less.

## Calibrations (rebuilt for each new filing date)

- **Mortgage duration scales:** weighted least squares of the quarterly change in securities fair value over cost on bucket-level par-duration exposures, 2021 Q4 to the latest quarter. Fit through 2024 Q4, tested on later quarters.
- **Deposit beta per bank:** change in domestic deposit cost over the change in fed funds, 2021 Q4 to 2023 Q4.
- **FDIC loss rates:** cost over assets at failure by size tier, 2008 on. A zero cost marked "LCT not performed" is treated as missing.
- **Discount window readiness:** banks' pledged lendable value at end-2023 (Fed) over the lendable value their call reports could support.
- **Rate presets:** the 2022 move by tenor, and the largest 12-month rise in the 2-year yield (July 1980 to July 1981) by tenor.

## Run locally

```bash
node --test tests/*.test.mjs
node scripts/collect.mjs --force
```

Output goes to `generated/`. Publishing runs only inside this repository's GitHub workflow.
