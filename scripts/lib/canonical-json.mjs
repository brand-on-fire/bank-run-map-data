// Canonical JSON: sorted object keys, no whitespace, so equal content gives equal bytes.
import { createHash } from 'node:crypto';

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) sorted[key] = sortValue(value[key]);
    }
    return sorted;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Non-finite number in canonical JSON');
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
