// Minimal ZIP reader for one trusted bulk file: central directory, stored or
// deflated entries, CRC-checked, ZIP64 size fields. No encryption or multi-disk archives.
import { inflateRawSync, crc32 } from 'node:zlib';

export class ZipError extends Error {
  constructor(message) { super(message); this.name = 'ZipError'; }
}

export function listZip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || buffer.length - eocd > 65_557) throw new ZipError('No end of central directory record');
  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset + size > eocd) throw new ZipError('Central directory out of range');
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new ZipError('Bad central directory entry');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    let compressed = buffer.readUInt32LE(offset + 20);
    let uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    let localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (flags & 0x1) throw new ZipError(`Encrypted entry ${name}`);
    const MAX = 0xffffffff;
    if (uncompressed === MAX || compressed === MAX || localOffset === MAX) {
      // ZIP64 extended information: only the fields that overflowed are present, in this order.
      let at = offset + 46 + nameLength;
      const end = at + extraLength;
      let found = false;
      while (at + 4 <= end) {
        const id = buffer.readUInt16LE(at);
        const length = buffer.readUInt16LE(at + 2);
        if (id === 0x0001) {
          let p = at + 4;
          const read64 = () => { const v = Number(buffer.readBigUInt64LE(p)); p += 8; return v; };
          if (uncompressed === MAX) uncompressed = read64();
          if (compressed === MAX) compressed = read64();
          if (localOffset === MAX) localOffset = read64();
          found = true;
          break;
        }
        at += 4 + length;
      }
      if (!found) throw new ZipError(`ZIP64 sizes without an extended information field for ${name}`);
    }
    entries.push({ name, method, crc, compressed, uncompressed, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntry(buffer, entry, { maxBytes = 200 * 1024 * 1024 } = {}) {
  if (entry.uncompressed > maxBytes) throw new ZipError(`${entry.name} exceeds ${maxBytes} bytes`);
  const at = entry.localOffset;
  if (buffer.readUInt32LE(at) !== 0x04034b50) throw new ZipError(`Bad local header for ${entry.name}`);
  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
  const raw = buffer.subarray(start, start + entry.compressed);
  let data;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) data = inflateRawSync(raw, { maxOutputLength: maxBytes });
  else throw new ZipError(`Unsupported compression method ${entry.method} for ${entry.name}`);
  if (data.length !== entry.uncompressed) throw new ZipError(`${entry.name} inflated to ${data.length} bytes, expected ${entry.uncompressed}`);
  if ((crc32(data) >>> 0) !== entry.crc) throw new ZipError(`${entry.name} failed its CRC check`);
  return data;
}
