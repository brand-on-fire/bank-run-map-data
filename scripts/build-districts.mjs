#!/usr/bin/env node
// Builds config/district-counties.json: every 2020 Census county or county equivalent in the
// 50 states and DC, keyed by 5-digit FIPS, mapped to its Federal Reserve district.
//
// Every assignment comes from the Board of Governors' "Federal Reserve District Boundaries"
// (March 1996). Board names are matched to the Census 2020 county list. A name the text cannot
// resolve on its own fails the build unless a reviewed entry in aliases.json resolves it.
// FDIC BankFind district codes only verify the result, except for a county named in a reviewed
// override whose evidence the build re-proves on every run.
//
// Usage: node scripts/build-districts.mjs [--check]
//   --check  rebuild in memory and exit 1 if config/district-counties.json is not current.
//
// Inputs, all in config/district-sources/ (nothing is fetched at run time):
//   frb_districts_1996.txt   text layer of the FRASER scan of the Board document (verbatim)
//   national_county2020.txt  Census 2020 county and county-equivalent FIPS codes
//   national_state2020.txt   Census 2020 state FIPS codes and names
//   aliases.json             reviewed resolutions for names the text cannot resolve by itself
//   fdic-institutions.json   FDIC BankFind active institutions, verbatim API response
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = join(ROOT, 'config', 'district-sources');
const OUTPUT = join(ROOT, 'config', 'district-counties.json');

// The Board text and Census files are pinned: aliases are reviewed against these exact bytes.
const INPUTS = {
  board: { file: 'frb_districts_1996.txt', sha256: '38d990803b0e2baab66eceef06b0792ff13c69a512f1a4f95e011728f6723438' },
  counties: {
    file: 'national_county2020.txt',
    sha256: '9f6e5f6eb6ac2f5e9a36d5fd01dec77991bddc75118f748a069441a4782970d6',
    url: 'https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt',
  },
  states: {
    file: 'national_state2020.txt',
    sha256: '167942161ec455bf7b0ee81b6ad76c109eb65e63136125d3683f8a44f51bbc66',
    url: 'https://www2.census.gov/geo/docs/reference/codes2020/national_state2020.txt',
  },
  aliases: { file: 'aliases.json' },
  fdic: {
    file: 'fdic-institutions.json',
    url: 'https://api.fdic.gov/banks/institutions?filters=ACTIVE:1&fields=CERT,STALP,STCNTY,COUNTY,FED&limit=10000',
  },
};
const BOARD = {
  citation: 'Board of Governors of the Federal Reserve System, Division of Reserve Bank Operations and Payment Systems, "Federal Reserve District Boundaries," March 1996',
  pdfUrl: 'https://fraser.stlouisfed.org/files/docs/historical/federal%20reserve%20history/frdistricts/frb_districts_199603.pdf',
  pdfSha256: '1950a0e45f2f9b37e25d2f0cf49c1fded9d78d21bd57a215a58d50ad2892ae4a',
};
const MAX_UNEXPLAINED_MISMATCHES = 10;
const DISTRICT_CODE = /^(0[1-9]|1[0-2])$/;
const CT_PLANNING_REGION = /^091[1-9]0$/; // 2022 Connecticut planning regions; the 2020 list has the old counties

class BuildError extends Error {}
const failures = [];
const fail = (message) => failures.push(message);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const collapse = (text) => text.replace(/\s+/g, ' ').trim();
const stripNumbers = (text) => text.replace(/(\s+\d[\d.,]*)+\s*$/, '').trim();
const district2 = (value) => String(value).padStart(2, '0');

// Comparison key: case, accents, punctuation and spacing ignored; "Saint" equals "St.".
function key(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\bsainte\b/g, 'ste').replace(/\bsaint\b/g, 'st').replace(/[^a-z0-9]/g, '');
}

// JSON with every object's keys in sorted order and a 2-space indent. Written by hand because
// JavaScript objects enumerate integer-like keys ("10", "48001") before "01" and "01001".
function canonicalJson(value, indent = '') {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((item) => inner + canonicalJson(item, inner)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const names = Object.keys(value).filter((name) => value[name] !== undefined).sort();
    if (!names.length) return '{}';
    return `{\n${names.map((name) => `${inner}${JSON.stringify(name)}: ${canonicalJson(value[name], inner)}`).join(',\n')}\n${indent}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new BuildError('non-finite number in output');
  return JSON.stringify(value);
}

function readInput(name) {
  const spec = INPUTS[name];
  const bytes = readFileSync(join(SOURCE_DIR, spec.file));
  const digest = sha256(bytes);
  if (spec.sha256 && digest !== spec.sha256) {
    throw new BuildError(`${spec.file}: sha256 ${digest} does not match the pinned ${spec.sha256}; re-review aliases.json before re-pinning`);
  }
  return { text: bytes.toString('utf8'), sha256: digest };
}

// ---------------------------------------------------------------- Census

function pipeRows(text, header, file) {
  const lines = text.split(/\r?\n/).filter((line) => line !== '');
  if (lines[0] !== header) throw new BuildError(`${file}: unexpected header "${lines[0]}"`);
  return lines.slice(1).map((line) => {
    const cells = line.split('|');
    if (cells.length !== header.split('|').length) throw new BuildError(`${file}: malformed row "${line}"`);
    return cells;
  });
}

function loadCensus(countyText, stateText) {
  const stateByAbbr = new Map();
  for (const [abbr, fips, , name] of pipeRows(stateText, 'STATE|STATEFP|STATENS|STATE_NAME', INPUTS.states.file)) {
    stateByAbbr.set(abbr, { abbr, fips, name, territory: Number(fips) >= 60 });
  }
  const counties = new Map(); // fips -> { fips, state, name, kind, base }
  const index = new Map(); // state abbr -> { county: Map(key -> fips[]), city: Map(key -> fips[]) }
  for (const [abbr, stateFips, countyFips, , name, classFp] of pipeRows(countyText, 'STATE|STATEFP|COUNTYFP|COUNTYNS|COUNTYNAME|CLASSFP|FUNCSTAT', INPUTS.counties.file)) {
    const state = stateByAbbr.get(abbr);
    if (!state || state.fips !== stateFips) throw new BuildError(`${INPUTS.counties.file}: ${abbr} ${stateFips} is not in the state list`);
    if (state.territory) continue; // territories are assigned whole, at the state level
    const fips = stateFips + countyFips;
    if (!/^\d{5}$/.test(fips) || counties.has(fips)) throw new BuildError(`${INPUTS.counties.file}: bad or repeated FIPS ${fips}`);
    // C7 is an independent city (Virginia, Baltimore, St. Louis, Carson City); the Board names
    // those only as "City of X" or inside a whole state, never in a "Counties of" list.
    const kind = classFp === 'C7' ? 'city' : 'county';
    const base = kind === 'city'
      ? name.replace(/ city$/, '')
      : name.replace(/ (County|Parish|Borough|Census Area|City and Borough|Municipality)$/, '');
    counties.set(fips, { fips, state: abbr, name, kind, base });
    if (!index.has(abbr)) index.set(abbr, { county: new Map(), city: new Map() });
    const bucket = index.get(abbr)[kind];
    const k = key(base);
    bucket.set(k, [...(bucket.get(k) ?? []), fips]);
  }
  for (const [abbr, buckets] of index) {
    for (const [kind, bucket] of Object.entries(buckets)) {
      for (const [k, list] of bucket) if (list.length > 1) throw new BuildError(`Census ${kind} names collide in ${abbr} after normalization: ${k} = ${list.join(', ')}`);
    }
  }
  const inScope = [...stateByAbbr.values()].filter((state) => !state.territory);
  for (const state of inScope) if (!index.has(state.abbr)) throw new BuildError(`Census list has no counties for ${state.abbr}`);
  if (inScope.length !== 51) throw new BuildError(`expected 50 states and DC in the Census state list, found ${inScope.length}`);
  return { stateByAbbr, counties, index };
}

// ---------------------------------------------------------------- Aliases

function loadAliases(text, census) {
  const raw = JSON.parse(text);
  if (raw.schemaVersion !== 1) throw new BuildError('aliases.json: schemaVersion must be 1');
  const need = (entry, fields, section) => {
    for (const field of fields) if (entry[field] === undefined || entry[field] === '') throw new BuildError(`aliases.json ${section}: entry ${JSON.stringify(entry)} lacks ${field}`);
    if (typeof entry.reason !== 'string' || entry.reason.length < 10 || entry.reason.includes('\n')) throw new BuildError(`aliases.json ${section}: "${entry.text ?? entry.fips}" needs a one-line reason`);
    if (entry.district !== undefined && !DISTRICT_CODE.test(entry.district)) throw new BuildError(`aliases.json ${section}: "${entry.text ?? entry.fips}" has district ${entry.district}; use 01 to 12`);
  };
  const states = (raw.states ?? []).map((entry) => {
    need(entry, ['text', 'state', 'reason'], 'states');
    if (!census.stateByAbbr.has(entry.state)) throw new BuildError(`aliases.json states: unknown state ${entry.state}`);
    return { ...entry, section: 'states', uses: 0 };
  });
  const counties = (raw.counties ?? []).map((entry) => {
    need(entry, ['district', 'listedUnder', 'text', 'reason'], 'counties');
    if (!entry.ignore && !entry.county) throw new BuildError(`aliases.json counties: "${entry.text}" needs county or ignore`);
    return { ...entry, section: 'counties', uses: 0 };
  });
  const cities = (raw.cities ?? []).map((entry) => {
    need(entry, ['district', 'listedUnder', 'text', 'withinCounty', 'reason'], 'cities');
    return { ...entry, section: 'cities', uses: 0 };
  });
  const fdicOverrides = (raw.fdicOverrides ?? []).map((entry) => {
    need(entry, ['fips', 'district', 'reason'], 'fdicOverrides');
    return { ...entry, section: 'fdicOverrides', uses: 0 };
  });
  return { states, counties, cities, fdicOverrides };
}

// ---------------------------------------------------------------- Board text

const IGNORED_LINE = [
  /^-\s*\d+\s*-$/, // page numbers
  /^Digitized for FRASER$/,
  /^http:\/\/fraser\.stlouisfed\.org\/?$/,
  /^Federal Reserve Bank of St\. Louis$/,
  /^(Land Area|Population)( (Land Area|Population))*$/,
  /^[\d.,\s]+$/, // land area and population figures
  /\bTotal\b/, // office, branch and district totals
];

function splitNames(list) {
  return list.split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((name) => name.trim()).filter(Boolean);
}

function parseParen(paren) {
  let match;
  const text = collapse(stripNumbers(paren).replace(/\)\s*$/, ''));
  if (/^(counties|parishes)\s*o\S{0,2}$/i.test(text)) return { kind: 'list' }; // OCR: "of)", "on", "oD", "oo"
  if ((match = text.match(/^City of (.+?),? and Counties of$/i))) return { kind: 'list', city: match[1] };
  if ((match = text.match(/^City of (.+?) only$/i))) return { kind: 'cityOnly', city: match[1] };
  if ((match = text.match(/^Except (.+?) Count(?:y|ies)(,? and the cities they surround)?$/i))) {
    return { kind: 'except', names: splitNames(match[1]), surrounded: Boolean(match[2]) };
  }
  if ((match = text.match(/^(.+?) Count(?:y|ies)( only|,? and the cities they surround)$/i))) {
    return { kind: 'only', names: splitNames(match[1]), surrounded: /surround/.test(match[2]) };
  }
  return null;
}

// Minimum-cost split of a line's tokens into known names: fewest unmatched tokens, then fewest
// names (so "Jefferson Davis" beats "Jefferson" + "Davis"). Two equally good splits is an error.
function segment(tokens, vocab) {
  const n = tokens.length;
  const best = new Array(n + 1);
  best[n] = { unmatched: 0, names: 0, ways: 1, step: null };
  for (let i = n - 1; i >= 0; i--) {
    let top = null;
    const consider = (j, matched) => {
      const rest = best[j];
      const candidate = { unmatched: rest.unmatched + (matched ? 0 : 1), names: rest.names + 1, ways: rest.ways, step: { j, matched } };
      if (!top || candidate.unmatched < top.unmatched || (candidate.unmatched === top.unmatched && candidate.names < top.names)) top = candidate;
      else if (candidate.unmatched === top.unmatched && candidate.names === top.names) top.ways += candidate.ways;
    };
    for (let j = i + 1; j <= Math.min(n, i + 6); j++) if (vocab.has(key(tokens.slice(i, j).join(' ')))) consider(j, true);
    consider(i + 1, false);
    best[i] = top;
  }
  const pieces = [];
  for (let i = 0; i < n;) {
    const { j, matched } = best[i].step;
    const text = tokens.slice(i, j).join(' ');
    const last = pieces.at(-1);
    if (!matched && last && !last.matched) last.text += ` ${text}`;
    else pieces.push({ text, matched });
    i = j;
  }
  return { pieces, ambiguous: best[0].ways > 1 };
}

function parseBoard(text, census, aliases) {
  const lines = text.split(/\r?\n/);
  const stateKeys = new Map(); // key -> abbr, states and DC only
  const territoryKeys = new Map();
  for (const state of census.stateByAbbr.values()) (state.territory ? territoryKeys : stateKeys).set(key(state.name), state.abbr);
  const stateAlias = (k, territory) => {
    const hit = aliases.states.find((entry) => key(entry.text) === k && census.stateByAbbr.get(entry.state).territory === territory);
    if (hit) hit.uses += 1;
    return hit?.state ?? null;
  };

  // District numbers and names, from the district page headings ("District 8 St. Louis").
  const districtNames = new Map();
  for (const raw of lines) {
    const match = collapse(raw).match(/^District (\d{1,2}) ([A-Z][A-Za-z. ]*[A-Za-z.])$/);
    if (!match) continue;
    const district = district2(match[1]);
    if (districtNames.has(district) && districtNames.get(district) !== match[2]) throw new BuildError(`District ${district} is named both ${districtNames.get(district)} and ${match[2]}`);
    districtNames.set(district, match[2]);
  }
  const districts = Array.from({ length: 12 }, (_, i) => district2(i + 1));
  if (districtNames.size !== 12 || !districts.every((d) => districtNames.has(d))) throw new BuildError('Board text must name districts 1 through 12');
  const districtByName = (name) => {
    const hit = [...districtNames].find(([, value]) => value === name);
    if (!hit) throw new BuildError(`no district is named "${name}"`);
    return hit[0];
  };

  const claims = new Map(); // fips -> [{ district, office, line, how, partial }]
  const addClaim = (fips, claim) => claims.set(fips, [...(claims.get(fips) ?? []), claim]);
  const wholeStates = [];
  const exceptClauses = [];
  const onlySurrounded = [];
  const territoryEntries = [];
  const footnotes = [];
  const ambiguousLines = [];
  const spellings = new Map();
  const occurrences = new Map();
  let matchedNames = 0;

  const countyIndex = (abbr) => census.index.get(abbr).county;
  const applicableAliases = (ctx) => aliases.counties.filter((entry) => entry.listedUnder === ctx.state
    && entry.district === ctx.district && (entry.office === undefined || entry.office === ctx.office));

  // One Board name under a state heading -> { fips } | { ignored } | null (unmatched).
  const resolveName = (text, ctx) => {
    const k = key(text);
    const occurrenceKey = [ctx.district, ctx.office, ctx.state, k].join('|');
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
    occurrences.set(occurrenceKey, occurrence);
    const hits = applicableAliases(ctx).filter((entry) => key(entry.text) === k && (entry.occurrence === undefined || entry.occurrence === occurrence));
    if (hits.length > 1) throw new BuildError(`line ${ctx.line}: more than one alias matches "${text}" under ${ctx.state}`);
    if (hits.length === 1) {
      const alias = hits[0];
      alias.uses += 1;
      if (alias.ignore) return { ignored: true };
      const target = alias.state ?? ctx.state;
      const fips = census.index.get(target)?.county.get(key(alias.county));
      if (!fips) throw new BuildError(`aliases.json: "${alias.county}" is not a 2020 Census county in ${target}`);
      alias.resolved = fips[0];
      return { fips: fips[0], alias };
    }
    if (ctx.closed) return null; // names after a whole-state, "except" or "only" line must be aliased
    const fips = countyIndex(ctx.state).get(k);
    if (!fips) return null;
    const entity = census.counties.get(fips[0]);
    if (collapse(text) !== entity.base) spellings.set(`${ctx.state}|${collapse(text)}`, { state: ctx.state, board: collapse(text), census: entity.name, fips: entity.fips });
    return { fips: fips[0] };
  };

  const resolveCity = (text, ctx, how) => {
    const fips = census.index.get(ctx.state).city.get(key(text));
    if (fips) {
      addClaim(fips[0], { district: ctx.district, office: ctx.office, line: ctx.line, how, partial: false });
      return;
    }
    const alias = aliases.cities.find((entry) => entry.listedUnder === ctx.state && entry.district === ctx.district && key(entry.text) === key(text));
    if (!alias) {
      fail(`line ${ctx.line}: City of ${text} is not a 2020 Census county equivalent in ${ctx.state}; add a reviewed cities alias naming its county`);
      return;
    }
    alias.uses += 1;
    const county = countyIndex(ctx.state).get(key(alias.withinCounty));
    if (!county) throw new BuildError(`aliases.json cities: ${alias.withinCounty} is not a county in ${ctx.state}`);
    alias.resolved = county[0];
    addClaim(county[0], { district: ctx.district, office: ctx.office, line: ctx.line, how: `City of ${text} only`, partial: true });
  };

  let phase = 'preamble';
  let territoryDistrict = null;
  let district = null;
  let office = null;
  let block = null; // { state, closed }

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = collapse(lines[i]);
    if (!line) continue;

    if (phase !== 'districts') {
      if (/^Population of Other Areas Included in Federal Reserve Districts$/.test(line)) { phase = 'territories'; continue; }
      if (phase === 'territories') {
        if (/^Note\./.test(line)) { phase = 'between'; continue; }
        const assigned = line.match(/^Assigned to the (.+) District:$/);
        if (assigned) { territoryDistrict = districtByName(assigned[1]); continue; }
        if (!territoryDistrict) throw new BuildError(`line ${lineNo}: territory "${line}" before any district`);
        if (/\d/.test(line)) territoryEntries.push({ district: territoryDistrict, text: stripNumbers(line), line: lineNo });
        else if (territoryEntries.at(-1)?.district === territoryDistrict) territoryEntries.at(-1).text += ` ${line}`; // wrapped entry
        else throw new BuildError(`line ${lineNo}: unexpected territory line "${line}"`);
        continue;
      }
      if (!/^District \d{1,2} [A-Z]/.test(line)) continue; // table of contents, maps, summary
      phase = 'districts';
    }

    if (IGNORED_LINE.some((pattern) => pattern.test(line))) continue;
    const districtHeading = line.match(/^District (\d{1,2})\b/);
    if (districtHeading) { district = district2(districtHeading[1]); office = null; block = null; continue; }
    const officeHeading = line.match(/^(.+?) (Head Office|Branch)(?:\s*[(<].*)?$/);
    if (officeHeading) { office = `${officeHeading[1]} ${officeHeading[2]}`; block = null; continue; }
    if (/^1\//.test(line)) { footnotes.push({ district, office, text: line.replace(/^1\/\s*/, ''), line: lineNo }); continue; }
    if (!district || !office) throw new BuildError(`line ${lineNo}: "${line}" is outside any district office`);

    // State heading?
    const open = line.indexOf('(');
    const statePart = stripNumbers(open < 0 ? line : line.slice(0, open));
    const abbr = stateKeys.get(key(statePart)) ?? stateAlias(key(statePart), false);
    if (open >= 0 && !abbr) throw new BuildError(`line ${lineNo}: unrecognized state heading "${line}"`);
    const loneName = abbr && open < 0 && !/\d/.test(line);
    if (loneName && block && !block.closed && countyIndex(block.state).has(key(statePart))) {
      // A lone state name inside a county list that has a county of that name is the county.
      ambiguousLines.push({ line: lineNo, text: line, readAs: `county in the ${block.state} list (${office})` });
    } else if (abbr) {
      const ctx = { state: abbr, district, office, line: lineNo };
      if (open < 0) {
        wholeStates.push(ctx);
        block = { state: abbr, closed: true };
        continue;
      }
      let paren = line.slice(open + 1);
      if (!paren.includes(')') && !/^(counties|parishes)\s*o/i.test(collapse(paren))) {
        // The heading wraps onto the next line (Virginia).
        let j = i;
        while (!paren.includes(')')) {
          j += 1;
          if (j >= lines.length || j > i + 2) throw new BuildError(`line ${lineNo}: unterminated heading "${line}"`);
          paren += ` ${collapse(lines[j])}`;
        }
        i = j;
      }
      const heading = parseParen(paren);
      if (!heading) throw new BuildError(`line ${lineNo}: unrecognized heading "${collapse(line.slice(0, open))} (${collapse(paren)}"`);
      if (heading.kind === 'list') {
        block = { state: abbr, closed: false };
        if (heading.city) resolveCity(heading.city, ctx, `City of ${heading.city}`);
        continue;
      }
      block = { state: abbr, closed: true };
      if (heading.kind === 'cityOnly') { resolveCity(heading.city, ctx, `City of ${heading.city} only`); continue; }
      const named = [];
      for (const name of heading.names) {
        const hit = resolveName(name, { ...ctx, closed: false });
        if (!hit?.fips) { fail(`line ${lineNo}: "${name}" in the ${abbr} heading matches no 2020 Census county; add a reviewed alias`); continue; }
        matchedNames += 1;
        named.push(hit.fips);
      }
      if (heading.kind === 'except') exceptClauses.push({ ...ctx, named, surrounded: heading.surrounded });
      else {
        for (const fips of named) addClaim(fips, { district, office, line: lineNo, how: 'named in an "only" heading', partial: false });
        if (heading.surrounded) onlySurrounded.push({ ...ctx, named });
      }
      continue;
    }

    // County names under the current state heading.
    if (!block) throw new BuildError(`line ${lineNo}: county names "${line}" under no state heading`);
    const ctx = { state: block.state, district, office, line: lineNo, closed: block.closed };
    const vocab = new Set(block.closed ? [] : countyIndex(block.state).keys());
    for (const entry of applicableAliases(ctx)) vocab.add(key(entry.text));
    const groups = [{ tokens: [], marked: false }];
    for (const token of line.split(' ')) {
      if (token === '1/') { groups.at(-1).marked = true; groups.push({ tokens: [], marked: false }); continue; }
      if (key(token) !== '') groups.at(-1).tokens.push(token);
    }
    for (const group of groups) {
      if (!group.tokens.length) { if (group.marked) fail(`line ${lineNo}: footnote marker without a name`); continue; }
      const { pieces, ambiguous } = segment(group.tokens, vocab);
      if (ambiguous) fail(`line ${lineNo}: "${group.tokens.join(' ')}" splits into county names more than one way`);
      pieces.forEach((piece, index) => {
        const hit = piece.matched ? resolveName(piece.text, ctx) : null;
        if (!hit) {
          fail(`line ${lineNo}: "${piece.text}" under ${block.state} (${office}, district ${district}) matches no 2020 Census county; add a reviewed alias`);
          return;
        }
        if (hit.ignored) return;
        matchedNames += 1;
        const partial = group.marked && index === pieces.length - 1;
        addClaim(hit.fips, { district, office, line: lineNo, how: hit.alias ? `alias "${piece.text}"` : 'county list', partial, footnote: partial });
      });
    }
  }

  // "Except" headings claim the rest of the state. "The cities they surround" is only decidable
  // when the matching "only" heading names the same counties in the same district.
  for (const clause of exceptClauses) {
    const named = new Set(clause.named);
    let surroundedPair = null;
    if (clause.surrounded) {
      const pairs = onlySurrounded.filter((only) => only.state === clause.state);
      const sameCounties = (only) => only.named.length === named.size && only.named.every((fips) => named.has(fips));
      if (pairs.length !== 1 || !sameCounties(pairs[0])) {
        fail(`${clause.state}: "the cities they surround" (line ${clause.line}) needs exactly one matching "only" heading naming the same counties`);
        continue;
      }
      surroundedPair = pairs[0];
      if (surroundedPair.district !== clause.district) {
        fail(`${clause.state}: "the cities they surround" falls in districts ${clause.district} and ${surroundedPair.district}; a reviewed list of those cities is required`);
        continue;
      }
    }
    for (const entity of census.counties.values()) {
      if (entity.state !== clause.state || named.has(entity.fips)) continue;
      const how = surroundedPair && entity.kind === 'city'
        ? `independent city: lines ${clause.line} and ${surroundedPair.line} both assign it, whether or not it is one of "the cities they surround"`
        : 'rest of state after an "Except" heading';
      addClaim(entity.fips, { district: clause.district, office: clause.office, line: clause.line, how, partial: false });
    }
  }
  for (const only of onlySurrounded) {
    if (!exceptClauses.some((clause) => clause.state === only.state && clause.surrounded)) fail(`${only.state}: line ${only.line} names "the cities they surround" with no matching "Except" heading`);
  }
  for (const whole of wholeStates) {
    for (const entity of census.counties.values()) {
      if (entity.state === whole.state) addClaim(entity.fips, { district: whole.district, office: whole.office, line: whole.line, how: 'whole state', partial: false });
    }
  }

  const territories = {};
  for (const entry of territoryEntries) {
    const k = key(entry.text);
    const abbr = territoryKeys.get(k) ?? stateAlias(k, true);
    if (!abbr) { fail(`line ${entry.line}: territory "${entry.text}" matches no Census state-level area; add a reviewed states alias`); continue; }
    const fips = census.stateByAbbr.get(abbr).fips;
    if (territories[fips]) fail(`line ${entry.line}: territory ${abbr} listed twice`);
    territories[fips] = entry.district;
  }
  if (!Object.keys(territories).length) fail('Board text lists no territories');

  return {
    districtNames, claims, wholeStates, exceptClauses, footnotes, ambiguousLines, territories, matchedNames,
    spellings: [...spellings.values()].sort((a, b) => a.fips.localeCompare(b.fips) || a.board.localeCompare(b.board)),
  };
}

// ---------------------------------------------------------------- Crosswalk

function resolveClaims(census, board) {
  const counties = {};
  const partialCounties = [];
  for (const fips of board.claims.keys()) if (!census.counties.has(fips)) fail(`claim for ${fips}, which is not a 2020 Census county`);
  let unassigned = 0;
  let duplicated = 0;
  for (const entity of census.counties.values()) {
    const list = board.claims.get(entity.fips) ?? [];
    const label = `${entity.fips} ${entity.name}, ${entity.state}`;
    const where = list.map((claim) => `district ${claim.district} ${claim.office} line ${claim.line} (${claim.how})`).join('; ');
    if (!list.length) { unassigned += 1; fail(`${label} is not assigned by the Board list`); continue; }
    if (list.length > 1 && !list.every((claim) => claim.partial)) { duplicated += 1; fail(`${label} is listed ${list.length} times: ${where}`); continue; }
    if (list.length === 1 && list[0].partial) { unassigned += 1; fail(`${label} is listed only in part: ${where}`); continue; }
    const districts = new Set(list.map((claim) => claim.district));
    if (districts.size > 1) { duplicated += 1; fail(`${label} is split between districts: ${where}`); continue; }
    if (list.length > 1) {
      partialCounties.push({
        fips: entity.fips,
        county: `${entity.name}, ${entity.state}`,
        district: list[0].district,
        parts: list.map((claim) => {
          const footnote = claim.footnote ? board.footnotes.find((note) => note.district === claim.district && note.office === claim.office) : null;
          if (claim.footnote && !footnote) fail(`${label}: ${claim.office} marks it 1/ but has no footnote`);
          return { office: claim.office, line: claim.line, how: footnote ? `footnote 1/: ${footnote.text}` : claim.how };
        }),
      });
    }
    counties[entity.fips] = list[0].district;
  }
  return { counties, partialCounties, unassigned, duplicated };
}

function summarizeStates(census, board, counties) {
  const byState = new Map();
  for (const [fips, district] of Object.entries(counties)) {
    const abbr = census.counties.get(fips).state;
    const tally = byState.get(abbr) ?? {};
    tally[district] = (tally[district] ?? 0) + 1;
    byState.set(abbr, tally);
  }
  const wholeStateLines = {};
  for (const whole of board.wholeStates) wholeStateLines[whole.state] = whole.district;
  const splitStates = {};
  const singleDistrictWithoutWholeStateLine = {};
  for (const [abbr, tally] of [...byState].sort(([a], [b]) => a.localeCompare(b))) {
    const list = Object.keys(tally);
    if (list.length > 1) splitStates[abbr] = tally;
    else if (!(abbr in wholeStateLines)) {
      const how = board.exceptClauses.some((clause) => clause.state === abbr) ? '"Except" heading plus the matching "only" heading' : 'county lists';
      singleDistrictWithoutWholeStateLine[abbr] = { district: list[0], counties: tally[list[0]], from: how };
    }
  }
  return { wholeStateLines, splitStates, singleDistrictWithoutWholeStateLine };
}

// ---------------------------------------------------------------- FDIC verification

function verifyFdic(fdicText, census, counties, territories, splitStates, aliases) {
  const response = JSON.parse(fdicText);
  const rows = (response.data ?? []).map((row) => row.data);
  if (!rows.length || response.meta?.total !== rows.length) throw new BuildError(`FDIC snapshot is incomplete: ${rows.length} of ${response.meta?.total} institutions`);

  const final = { ...counties };
  const banksByCounty = new Map();
  for (const row of rows) banksByCounty.set(String(row.STCNTY), [...(banksByCounty.get(String(row.STCNTY)) ?? []), row]);

  const overrides = [];
  for (const override of aliases.fdicOverrides) {
    override.uses += 1;
    const entity = census.counties.get(override.fips);
    if (!entity) { fail(`fdicOverrides: ${override.fips} is not a 2020 Census county`); continue; }
    const banks = banksByCounty.get(override.fips) ?? [];
    const agreeing = banks.filter((row) => district2(row.FED) === override.district);
    if (counties[override.fips] === override.district) fail(`fdicOverrides: ${override.fips} already maps to ${override.district}; remove the override`);
    if (!banks.length || agreeing.length !== banks.length) {
      fail(`fdicOverrides: ${override.fips} evidence fails: ${agreeing.length} of ${banks.length} active banks report district ${override.district}`);
      continue;
    }
    final[override.fips] = override.district;
    overrides.push({
      fips: override.fips,
      county: `${entity.name}, ${entity.state}`,
      boardDistrict: counties[override.fips],
      district: override.district,
      evidence: { activeBanks: banks.length, agreeWithOverride: agreeing.length, certs: banks.map((row) => row.CERT).sort((a, b) => a - b) },
      reason: override.reason,
    });
  }

  let compared = 0;
  let agreeBoard = 0;
  let agreeFinal = 0;
  const connecticutSkipped = [];
  const notInCrosswalk = [];
  const mismatches = [];
  const countiesCompared = new Set();
  for (const row of rows) {
    const stcnty = String(row.STCNTY);
    const fed = district2(row.FED);
    const stateFips = stcnty.slice(0, 2);
    let board;
    let crosswalk;
    if (territories[stateFips]) board = crosswalk = territories[stateFips];
    else if (stateFips === '09' && CT_PLANNING_REGION.test(stcnty)) { connecticutSkipped.push(row.CERT); continue; }
    else if (counties[stcnty]) { board = counties[stcnty]; crosswalk = final[stcnty]; }
    else { notInCrosswalk.push({ CERT: row.CERT, STALP: row.STALP, STCNTY: stcnty, COUNTY: row.COUNTY, FED: fed }); continue; }
    compared += 1;
    if (counties[stcnty]) countiesCompared.add(stcnty);
    if (fed === board) agreeBoard += 1;
    if (fed === crosswalk) { agreeFinal += 1; continue; }
    mismatches.push({ CERT: row.CERT, STALP: row.STALP, STCNTY: stcnty, COUNTY: row.COUNTY, fdicFED: fed, crosswalk });
  }
  mismatches.sort((a, b) => a.STCNTY.localeCompare(b.STCNTY) || a.CERT - b.CERT);
  // Overrides already apply above, so every mismatch left is unexplained.
  const unexplained = mismatches.length;
  if (unexplained > MAX_UNEXPLAINED_MISMATCHES) fail(`FDIC: ${unexplained} unexplained mismatches (limit ${MAX_UNEXPLAINED_MISMATCHES})`);
  const inSplitStates = (fips) => Object.hasOwn(splitStates, census.counties.get(fips).state);
  const splitStateCounties = Object.keys(counties).filter(inSplitStates);

  return {
    final,
    overrides,
    check: {
      snapshot: { indexName: response.meta?.index?.name, indexCreated: response.meta?.index?.createTimestamp, activeInstitutions: rows.length },
      compared,
      countiesWithBanks: countiesCompared.size,
      splitStateCountiesWithBanks: `${[...countiesCompared].filter(inSplitStates).length} of ${splitStateCounties.length}`,
      agreeWithBoard: agreeBoard,
      agreeWithCrosswalk: agreeFinal,
      mismatches,
      unexplainedMismatches: unexplained,
      maxUnexplainedMismatches: MAX_UNEXPLAINED_MISMATCHES,
      skippedConnecticutPlanningRegions: { count: connecticutSkipped.length, reason: 'STCNTY is a 2022 planning region (091x0) and the API gives only the region name, not one of the 8 old counties', certs: connecticutSkipped.sort((a, b) => a - b) },
      notInCrosswalk: notInCrosswalk.sort((a, b) => a.STCNTY.localeCompare(b.STCNTY) || a.CERT - b.CERT),
    },
  };
}

// ---------------------------------------------------------------- Main

function build() {
  const boardInput = readInput('board');
  const countyInput = readInput('counties');
  const stateInput = readInput('states');
  const aliasInput = readInput('aliases');
  const fdicInput = readInput('fdic');

  const census = loadCensus(countyInput.text, stateInput.text);
  const aliases = loadAliases(aliasInput.text, census);
  const board = parseBoard(boardInput.text, census, aliases);
  const resolved = resolveClaims(census, board);
  const states = summarizeStates(census, board, resolved.counties);
  const fdic = verifyFdic(fdicInput.text, census, resolved.counties, board.territories, states.splitStates, aliases);

  const aliasEntries = [...aliases.states, ...aliases.counties, ...aliases.cities, ...aliases.fdicOverrides];
  for (const entry of aliasEntries) {
    if (!entry.uses) fail(`aliases.json ${entry.section}: "${entry.text ?? entry.fips ?? entry.cert}" was never used; remove it or fix it`);
  }

  const districtCounties = {};
  for (const district of board.districtNames.keys()) districtCounties[district] = 0;
  for (const district of Object.values(fdic.final)) districtCounties[district] += 1;
  for (const [district, count] of Object.entries(districtCounties)) if (!count) fail(`district ${district} has no counties`);

  const output = {
    schemaVersion: 1,
    source: {
      board: `${BOARD.citation}. ${BOARD.pdfUrl}`,
      boardPdfSha256: BOARD.pdfSha256,
      boardTextSha256: boardInput.sha256,
      census: {
        url: INPUTS.counties.url,
        sha256: countyInput.sha256,
        stateList: { url: INPUTS.states.url, sha256: stateInput.sha256 },
      },
      fdic: { url: INPUTS.fdic.url, sha256: fdicInput.sha256 },
      aliasesSha256: aliasInput.sha256,
    },
    counties: fdic.final,
    territories: board.territories,
    checks: {
      coverage: {
        censusCountiesAndEquivalents: census.counties.size,
        statesAndDc: new Set([...census.counties.values()].map((entity) => entity.state)).size,
        assignedExactlyOnce: Object.keys(resolved.counties).length,
        unassigned: resolved.unassigned,
        listedTwice: resolved.duplicated,
        boardNamesMatched: board.matchedNames,
        territories: Object.keys(board.territories).length,
      },
      districtNames: Object.fromEntries(board.districtNames),
      countiesPerDistrict: districtCounties,
      wholeStateLines: states.wholeStateLines,
      singleDistrictWithoutWholeStateLine: states.singleDistrictWithoutWholeStateLine,
      splitStates: states.splitStates,
      partialCounties: resolved.partialCounties,
      ambiguousLines: board.ambiguousLines,
      spellingsNormalized: board.spellings,
      aliasesUsed: aliasEntries.filter((entry) => entry.section !== 'fdicOverrides').map((entry) => ({
        section: entry.section,
        text: entry.text,
        district: entry.district,
        office: entry.office,
        listedUnder: entry.listedUnder,
        occurrence: entry.occurrence,
        resolvesTo: entry.ignore ? 'ignored' : entry.section === 'states' ? entry.state : entry.resolved,
        uses: entry.uses,
        reason: entry.reason,
      })),
      fdic: fdic.check,
      fdicOverrides: fdic.overrides,
    },
  };
  return `${canonicalJson(output)}\n`;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  let json;
  try {
    json = build();
  } catch (error) {
    if (!(error instanceof BuildError)) throw error;
    failures.push(error.message);
  }
  if (failures.length) {
    console.error(`build-districts: ${failures.length} check(s) failed; ${OUTPUT} was not written`);
    for (const message of failures) console.error(`  - ${message}`);
    process.exit(1);
  }
  const summary = JSON.parse(json).checks;
  const line = `${summary.coverage.assignedExactlyOnce} counties, ${Object.keys(summary.splitStates).length} split states, FDIC ${summary.fdic.agreeWithCrosswalk}/${summary.fdic.compared} agree, ${summary.fdic.unexplainedMismatches} unexplained`;
  if (checkOnly) {
    let current = '';
    try { current = readFileSync(OUTPUT, 'utf8'); } catch {}
    if (current !== json) {
      console.error(`build-districts: ${OUTPUT} is not current; run node scripts/build-districts.mjs`);
      process.exit(1);
    }
    console.log(`build-districts: current (${line})`);
    return;
  }
  writeFileSync(OUTPUT, json);
  console.log(`build-districts: wrote ${OUTPUT} (${line})`);
}

main();
