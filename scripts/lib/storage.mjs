// Content-addressed writes, retention and the storage guard (ported from
// embassy-manager-data collector-template/publish.py storage_guard).
import { mkdir, readFile, writeFile, readdir, lstat, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256Hex } from './canonical-json.mjs';
import { CONTENT_DIRECTORIES } from './constants.mjs';

export class StorageError extends Error {
  constructor(message) { super(message); this.name = 'StorageError'; }
}

export const FIXED_PATHS = Object.freeze(['manifest.json', 'status.json', 'NOTICE.md', 'state/collector-state.json']);
export const CONTENT_PATH = new RegExp(`^(?:${CONTENT_DIRECTORIES.join('|')})/[a-f0-9]{64}\\.json$`);
const ENTRY_ID = /^[a-z0-9][a-z0-9:-]{1,63}$/;

export function allowedPath(relativePath) {
  return FIXED_PATHS.includes(relativePath) || CONTENT_PATH.test(relativePath);
}

export async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeFileAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, data);
  await rename(temporary, file);
}

export async function writeJson(file, value) {
  await writeFileAtomic(file, canonicalJson(value));
}

export async function writeContent(root, directory, value) {
  if (!CONTENT_DIRECTORIES.includes(directory)) throw new StorageError(`Unknown content directory ${directory}`);
  const bytes = Buffer.from(canonicalJson(value));
  const sha256 = sha256Hex(bytes);
  const relativePath = `${directory}/${sha256}.json`;
  await writeFileAtomic(path.join(root, relativePath), bytes);
  return { path: relativePath, sha256, bytes: bytes.length };
}

// Lists every file under root; symbolic links or special files are refused.
export async function listFiles(root) {
  const found = [];
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const name of entries) {
      const full = path.join(directory, name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new StorageError('Symbolic links are forbidden in public data');
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) found.push({ relativePath: path.relative(root, full).split(path.sep).join('/'), bytes: info.size });
      else throw new StorageError('Special files are forbidden in public data');
    }
  }
  await walk(root);
  return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

// Retention keeps every path the manifest references plus the previous generation
// of each entry, so a client holding a cached manifest can still fetch its files.
export function retainedPaths(manifest, state) {
  const keep = new Set((manifest?.files ?? []).map((entry) => entry.path));
  for (const paths of Object.values(state?.publishedPaths ?? {})) for (const item of paths) keep.add(item);
  return keep;
}

export async function pruneUnreferenced(root, keep) {
  const removed = [];
  for (const file of await listFiles(root)) {
    if (CONTENT_PATH.test(file.relativePath) && !keep.has(file.relativePath)) {
      await unlink(path.join(root, file.relativePath));
      removed.push(file.relativePath);
    }
  }
  return removed;
}

export async function storageGuard(root, { repositoryBytes, localGitBytes = 0, maxPayloadBytes, maxRepositoryBytes }) {
  if (!Number.isInteger(repositoryBytes) || repositoryBytes < 0) throw new StorageError('Repository size must be established before publishing');
  const files = await listFiles(root);
  let payload = 0;
  for (const file of files) {
    if (!allowedPath(file.relativePath)) throw new StorageError(`Unexpected publication file ${file.relativePath}`);
    payload += file.bytes;
    const body = await readFile(path.join(root, file.relativePath));
    if (file.relativePath.endsWith('.json')) JSON.parse(body.toString('utf8'));
    if (CONTENT_PATH.test(file.relativePath) && sha256Hex(body) !== path.basename(file.relativePath, '.json')) {
      throw new StorageError(`Content-addressed file ${file.relativePath} does not match its sha256`);
    }
  }
  const manifest = await readJsonIfExists(path.join(root, 'manifest.json'));
  const status = await readJsonIfExists(path.join(root, 'status.json'));
  const state = await readJsonIfExists(path.join(root, 'state/collector-state.json'));
  if (!manifest || !status || !state) throw new StorageError('manifest.json, status.json and state/collector-state.json are required');
  if (manifest.schemaVersion !== 1 || manifest.scheduleGuarantee !== false || !Array.isArray(manifest.files) || manifest.files.length > 200) {
    throw new StorageError('Invalid public manifest');
  }
  if (status.schemaVersion !== 1 || status.scheduleGuarantee !== false) throw new StorageError('Invalid public status');
  const ids = new Set();
  for (const entry of manifest.files) {
    if (!ENTRY_ID.test(entry.id ?? '') || ids.has(entry.id)) throw new StorageError(`Invalid or repeated manifest id ${entry.id}`);
    ids.add(entry.id);
    if (!CONTENT_PATH.test(entry.path ?? '') || path.basename(entry.path, '.json') !== entry.sha256) {
      throw new StorageError(`Manifest path for ${entry.id} is not its exact content-addressed path`);
    }
    let body;
    try { body = await readFile(path.join(root, entry.path)); } catch { throw new StorageError(`Manifest file for ${entry.id} is missing`); }
    if (!Number.isInteger(entry.bytes) || entry.bytes !== body.length || sha256Hex(body) !== entry.sha256) {
      throw new StorageError(`Manifest hash or byte count for ${entry.id} does not match`);
    }
  }
  const keep = retainedPaths(manifest, state);
  for (const file of files) {
    if (CONTENT_PATH.test(file.relativePath) && !keep.has(file.relativePath)) throw new StorageError(`Unreferenced content file ${file.relativePath}`);
  }
  if (payload > maxPayloadBytes || Math.max(repositoryBytes, localGitBytes) + payload > maxRepositoryBytes) {
    throw new StorageError('MAINTENANCE REQUIRED: publication stopped at its payload/repository storage limit; paid expansion is prohibited');
  }
  return { payload, files: files.length };
}
