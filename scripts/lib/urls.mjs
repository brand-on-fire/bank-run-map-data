// The only place request URLs are built, plus the last check before any network call.
import { FDIC_ORIGIN, TREASURY_ORIGIN, FRED_ORIGIN, FFIEC_ORIGIN, MARGINS_ORIGIN, FRB_ORIGIN, ALLOWED_HOSTS, FDIC_ENDPOINTS } from './constants.mjs';

export class RequestGuardError extends Error {
  constructor(message) { super(message); this.name = 'RequestGuardError'; }
}

const FIELD = /^[A-Z][A-Z0-9_]{0,30}$/;
const TREASURY_PATH = /^\/resource-center\/data-chart-center\/interest-rates\/daily-treasury-rates\.csv\/(\d{4})\/all$/;
export const FFIEC_BULK_PATH = '/public/PWS/DownloadBulkData.aspx';
export const MARGINS_PATHS = Object.freeze({
  current: '/pages/collateral/collateral_valuation',
});

export function fdicUrl(endpoint, { filters, fields, sortBy, sortOrder = 'ASC', limit = 10_000, offset = 0 } = {}) {
  if (!FDIC_ENDPOINTS.includes(endpoint)) throw new RequestGuardError(`Unknown FDIC endpoint ${endpoint}`);
  if (!Array.isArray(fields) || fields.length === 0 || !fields.every((f) => FIELD.test(f))) throw new RequestGuardError('FDIC fields must be upper-case names');
  if (sortBy && !FIELD.test(sortBy)) throw new RequestGuardError('Invalid sort field');
  const params = new URLSearchParams();
  if (filters) params.set('filters', filters);
  params.set('fields', fields.join(','));
  if (sortBy) { params.set('sort_by', sortBy); params.set('sort_order', sortOrder); }
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return `${FDIC_ORIGIN}/banks/${endpoint}?${params}`;
}

export function treasuryCurveUrl(year) {
  if (!Number.isInteger(year) || year < 1990 || year > 2100) throw new RequestGuardError(`Invalid curve year ${year}`);
  const params = new URLSearchParams({ type: 'daily_treasury_yield_curve', field_tdr_date_value: String(year), page: '', _format: 'csv' });
  return `${TREASURY_ORIGIN}/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?${params}`;
}

export function fredUrl(series) {
  if (!Array.isArray(series) || !series.every((s) => /^[A-Z0-9]{2,12}$/.test(s))) throw new RequestGuardError('Invalid FRED series');
  return `${FRED_ORIGIN}/graph/fredgraph.csv?id=${series.join(',')}`;
}

// Fed lending disclosures used to label the 2023 replay (frozen files).
export const FRB_FILES = Object.freeze({
  btfp: '/publications/files/section-11s-btfp-transaction-specific-disclosures-03-12-25.xlsx',
  dw2023q1: '/regreform/files/dw_data_2023_q1.xlsx',
  dw2023q2: '/regreform/files/dw_data_2023_q2.xlsx',
});
export const frbFileUrl = (id) => { if (!FRB_FILES[id]) throw new RequestGuardError(`Unknown Fed file ${id}`); return `${FRB_ORIGIN}${FRB_FILES[id]}`; };

export const ffiecBulkUrl = () => `${FFIEC_ORIGIN}${FFIEC_BULK_PATH}`;
export const marginsUrl = () => `${MARGINS_ORIGIN}${MARGINS_PATHS.current}`;

export function assertRequestAllowed(urlText) {
  let url;
  try { url = new URL(urlText); } catch { throw new RequestGuardError('Unparseable request URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new RequestGuardError(`Request URL must be plain https: ${urlText}`);
  if (!ALLOWED_HOSTS.includes(url.hostname)) throw new RequestGuardError(`Host ${url.hostname} is not allowed`);
  const ok = {
    'api.fdic.gov': () => FDIC_ENDPOINTS.some((e) => url.pathname === `/banks/${e}`),
    'home.treasury.gov': () => TREASURY_PATH.test(url.pathname),
    'fred.stlouisfed.org': () => url.pathname === '/graph/fredgraph.csv',
    'cdr.ffiec.gov': () => url.pathname === FFIEC_BULK_PATH && !url.search,
    'www.frbdiscountwindow.org': () => Object.values(MARGINS_PATHS).includes(url.pathname) && !url.search,
    'www.federalreserve.gov': () => Object.values(FRB_FILES).includes(url.pathname) && !url.search,
  }[url.hostname];
  if (!ok()) throw new RequestGuardError(`Path ${url.pathname} is not allowed on ${url.hostname}`);
  return url;
}
