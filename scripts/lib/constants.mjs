// Fixed identities and formats. Anything a human may tune lives in config/.

export const REPOSITORY = 'brand-on-fire/bank-run-map-data';
export const DATA_BRANCH = 'public-data';
export const DEFAULT_BRANCH = 'main';

export const FDIC_ORIGIN = 'https://api.fdic.gov';
export const TREASURY_ORIGIN = 'https://home.treasury.gov';
export const FRED_ORIGIN = 'https://fred.stlouisfed.org';
export const FFIEC_ORIGIN = 'https://cdr.ffiec.gov';
export const MARGINS_ORIGIN = 'https://www.frbdiscountwindow.org';
export const FRB_ORIGIN = 'https://www.federalreserve.gov';
export const ALLOWED_HOSTS = Object.freeze([
  'api.fdic.gov', 'home.treasury.gov', 'fred.stlouisfed.org', 'cdr.ffiec.gov', 'www.frbdiscountwindow.org', 'www.federalreserve.gov',
]);

export const FDIC_ENDPOINTS = Object.freeze(['financials', 'institutions', 'sod', 'failures']);
export const FDIC_PAGE = 10_000; // API maximum rows per request

export const CONTENT_DIRECTORIES = Object.freeze(['banks', 'curves', 'calibration', 'failures', 'replays']);

export const CITATIONS = Object.freeze({
  fdic: 'FDIC BankFind Suite API (call reports, Summary of Deposits, failures), api.fdic.gov',
  ffiec: 'FFIEC Central Data Repository bulk call reports, cdr.ffiec.gov',
  treasury: 'U.S. Treasury daily par yield curve, home.treasury.gov',
  fred: 'Federal Reserve Board H.15 via FRED (DGS2, DGS10, DFF), fred.stlouisfed.org',
  margins: 'Federal Reserve discount window collateral margins, frbdiscountwindow.org',
  lending: 'Federal Reserve Board, BTFP and discount window transaction-level disclosures, federalreserve.gov',
});

// Federal Reserve district codes as FDIC reports them (institutions.FED).
export const DISTRICTS = Object.freeze({
  '01': 'Boston', '02': 'New York', '03': 'Philadelphia', '04': 'Cleveland', '05': 'Richmond', '06': 'Atlanta',
  '07': 'Chicago', '08': 'St. Louis', '09': 'Minneapolis', '10': 'Kansas City', '11': 'Dallas', '12': 'San Francisco',
});

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
