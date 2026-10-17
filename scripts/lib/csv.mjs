// Strict RFC 4180 parser. Accepts CRLF or LF line endings, rejects
// bare CR, blank lines, stray quotes, ragged rows, NUL and a byte order mark.

export class CsvError extends Error {
  constructor(message) { super(message); this.name = 'CsvError'; }
}

export function parseCsv(text) {
  if (typeof text !== 'string' || text.length === 0) throw new CsvError('Empty CSV body');
  if (text.charCodeAt(0) === 0xfeff) throw new CsvError('CSV body starts with a byte order mark');
  if (text.includes('\u0000')) throw new CsvError('CSV body contains NUL');

  const records = [];
  let record = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false; // any character (including an opening quote) seen for this field
  let closedQuote = false; // the current field was quoted and its closing quote was seen
  let recordStarted = false;

  const endField = () => {
    record.push(field);
    field = '';
    fieldStarted = false;
    closedQuote = false;
  };
  const endRecord = () => {
    if (!recordStarted) throw new CsvError(`Blank line at record ${records.length + 1}`);
    endField();
    records.push(record);
    record = [];
    recordStarted = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; closedQuote = true; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === ',') { recordStarted = true; endField(); continue; }
    if (c === '\r') {
      if (text[i + 1] !== '\n') throw new CsvError('Bare carriage return');
      endRecord();
      i += 1;
      continue;
    }
    if (c === '\n') { endRecord(); continue; }
    if (closedQuote) throw new CsvError('Characters after a closing quote');
    if (c === '"') {
      if (fieldStarted) throw new CsvError('Quote inside an unquoted field');
      inQuotes = true;
      fieldStarted = true;
      recordStarted = true;
      continue;
    }
    field += c;
    fieldStarted = true;
    recordStarted = true;
  }
  if (inQuotes) throw new CsvError('Unterminated quoted field');
  if (recordStarted || fieldStarted) endRecord();
  if (records.length === 0) throw new CsvError('CSV has no header');

  const [header, ...rows] = records;
  rows.forEach((row, index) => {
    if (row.length !== header.length) throw new CsvError(`Row ${index + 1} has ${row.length} fields; header has ${header.length}`);
  });
  return { header, rows };
}

export function formatCsv(header, rows) {
  const cell = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
