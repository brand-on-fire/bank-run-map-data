#!/usr/bin/env node
// Public data transport (ported from embassy-manager-data collector-template/publish.py).
//   restore   anonymous depth-1 fetch of public-data into generated/ (empty dir required)
//   keepalive heartbeat commit to main at most once per 30 days
//   publish   storage guard, then an ordinary commit (commit-tree with the restored
//             parent) pushed without force; the branch is append-only
// GitHub-hosted public workflow only; refuses to run anywhere else.
import { mkdir, readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_BRANCH, DEFAULT_BRANCH } from './lib/constants.mjs';
import { checkActionsContext, fetchRepository, runProvenance } from './lib/provenance.mjs';
import { git, gitText, pushEnv, remoteHead, fetchBranch, listTree, REMOTE_URL, BOT_IDENTITY, GitError } from './lib/git.mjs';
import { allowedPath, readJsonIfExists, writeJson, writeFileAtomic, storageGuard, pruneUnreferenced, retainedPaths, StorageError } from './lib/storage.mjs';
import { keepaliveDue, heartbeatContent, HEARTBEAT_PATH } from './lib/keepalive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = path.join(ROOT, 'generated');
const RUNTIME = path.join(ROOT, 'runtime');

async function loadPolicy() {
  return JSON.parse(await readFile(path.join(ROOT, 'config', 'policy.json'), 'utf8'));
}

async function directoryBytes(directory) {
  let total = 0;
  for (const name of await readdir(directory)) {
    const full = path.join(directory, name);
    const info = await lstat(full);
    if (info.isDirectory()) total += await directoryBytes(full);
    else if (info.isFile()) total += info.size;
  }
  return total;
}

async function restore(env) {
  checkActionsContext(env);
  const policy = await loadPolicy();
  const repository = await fetchRepository(env.GH_TOKEN);
  if (repository.sizeBytes >= policy.publication.maxRepositoryBytes) {
    throw new StorageError('MAINTENANCE REQUIRED: repository reached its size limit; publication stopped');
  }
  await mkdir(GENERATED, { recursive: true });
  if ((await readdir(GENERATED)).length) throw new StorageError('Restore requires an empty generated directory');
  const head = remoteHead(DATA_BRANCH, { cwd: ROOT });
  let previousCommit = null;
  let files = 0;
  if (head) {
    previousCommit = fetchBranch(DATA_BRANCH, `refs/remotes/origin/${DATA_BRANCH}`, { cwd: ROOT });
    if (previousCommit !== head) throw new GitError('public-data moved during restore');
    const tree = listTree(previousCommit, { cwd: ROOT });
    const total = tree.reduce((sum, entry) => sum + entry.size, 0);
    if (tree.some((entry) => entry.mode !== '100644' || entry.type !== 'blob' || !allowedPath(entry.path)) || total > policy.publication.maxPayloadBytes) {
      throw new StorageError('Previous public-data commit contains unsupported files or exceeds its cap');
    }
    for (const entry of tree) {
      await writeFileAtomic(path.join(GENERATED, entry.path), git(['cat-file', 'blob', entry.sha], { cwd: ROOT }));
      files += 1;
    }
  }
  await writeJson(path.join(RUNTIME, 'restore.json'), { previousCommit, repositoryBytes: repository.sizeBytes, restoredAt: new Date().toISOString(), files });
  console.log(previousCommit ? `Restored ${files} files from public-data ${previousCommit}.` : 'No public-data branch yet; starting from an empty publication.');
}

async function keepalive(env) {
  checkActionsContext(env);
  const policy = await loadPolicy();
  const statePath = path.join(GENERATED, 'state', 'collector-state.json');
  const state = (await readJsonIfExists(statePath)) ?? { schemaVersion: 1, keepalive: { lastCommittedAt: null, lastCommit: null }, publishedPaths: {} };
  state.keepalive ??= { lastCommittedAt: null, lastCommit: null };
  const nowMs = Date.now();
  const intervalDays = policy.publication.keepaliveDays;
  if (!keepaliveDue({ nowMs, lastCommittedAt: state.keepalive.lastCommittedAt, mainHeadCommittedAt: null, intervalDays })) {
    console.log(`Keepalive not due (last heartbeat ${state.keepalive.lastCommittedAt}).`);
    return;
  }
  const head = fetchBranch(DEFAULT_BRANCH, `refs/remotes/origin/${DEFAULT_BRANCH}`, { cwd: ROOT });
  const mainHeadCommittedAt = gitText(['log', '-1', '--format=%cI', head], { cwd: ROOT });
  if (!keepaliveDue({ nowMs, lastCommittedAt: state.keepalive.lastCommittedAt, mainHeadCommittedAt, intervalDays })) {
    console.log(`Keepalive not due (main has a commit from ${mainHeadCommittedAt}).`);
    return;
  }
  const nowIso = new Date(nowMs).toISOString();
  const run = runProvenance(env, nowIso);
  const indexEnv = { GIT_INDEX_FILE: path.join(RUNTIME, 'keepalive.index'), ...BOT_IDENTITY };
  await mkdir(RUNTIME, { recursive: true });
  git(['read-tree', head], { cwd: ROOT, env: indexEnv });
  const blob = gitText(['hash-object', '-w', '--stdin'], { cwd: ROOT, input: heartbeatContent({ nowIso, runUrl: run.url }) });
  git(['update-index', '--add', '--cacheinfo', `100644,${blob},${HEARTBEAT_PATH}`], { cwd: ROOT, env: indexEnv });
  const tree = gitText(['write-tree'], { cwd: ROOT, env: indexEnv });
  const commit = gitText(['commit-tree', tree, '-p', head, '-m', `Collector heartbeat ${nowIso.slice(0, 10)}`], { cwd: ROOT, env: indexEnv });
  git(['push', REMOTE_URL, `${commit}:refs/heads/${DEFAULT_BRANCH}`], { cwd: ROOT, env: { ...indexEnv, ...pushEnv(env.GH_TOKEN) } });
  state.keepalive = { lastCommittedAt: nowIso, lastCommit: commit };
  await writeJson(statePath, state);
  console.log(`Committed keepalive heartbeat ${commit} to main.`);
}

async function publish(env) {
  checkActionsContext(env);
  const policy = await loadPolicy();
  const repository = await fetchRepository(env.GH_TOKEN);
  const restored = await readJsonIfExists(path.join(RUNTIME, 'restore.json'));
  if (!restored) throw new StorageError('Restore metadata missing; refusing to publish');
  const manifest = await readJsonIfExists(path.join(GENERATED, 'manifest.json'));
  const state = await readJsonIfExists(path.join(GENERATED, 'state', 'collector-state.json'));
  if (!manifest || !state) throw new StorageError('Nothing collected yet; no manifest or state to publish');
  await pruneUnreferenced(GENERATED, retainedPaths(manifest, state));
  const guard = await storageGuard(GENERATED, {
    repositoryBytes: repository.sizeBytes,
    localGitBytes: await directoryBytes(path.join(ROOT, '.git')),
    maxPayloadBytes: policy.publication.maxPayloadBytes,
    maxRepositoryBytes: policy.publication.maxRepositoryBytes,
  });
  const indexEnv = { GIT_DIR: path.join(ROOT, '.git'), GIT_WORK_TREE: GENERATED, GIT_INDEX_FILE: path.join(RUNTIME, 'publish.index'), ...BOT_IDENTITY };
  git(['read-tree', '--empty'], { cwd: GENERATED, env: indexEnv });
  git(['add', '--all', '--force', '.'], { cwd: GENERATED, env: indexEnv });
  const tree = gitText(['write-tree'], { cwd: GENERATED, env: indexEnv });
  const parent = restored.previousCommit;
  if (parent && tree === gitText(['rev-parse', `${parent}^{tree}`], { cwd: ROOT })) {
    console.log('No publication changes; no commit or push.');
    return;
  }
  const status = await readJsonIfExists(path.join(GENERATED, 'status.json'));
  const message = `Publish bank-run-map data: ${status?.outcome ?? 'unknown'} (run ${status?.run?.id ?? 'local'})`;
  const commit = gitText(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { cwd: ROOT, env: indexEnv });
  git(['push', REMOTE_URL, `${commit}:refs/heads/${DATA_BRANCH}`], { cwd: ROOT, env: { ...BOT_IDENTITY, ...pushEnv(env.GH_TOKEN) } });
  console.log(`Published ${commit} to ${DATA_BRANCH} with an ordinary commit (${guard.files} files, ${guard.payload} bytes; repository ${repository.sizeBytes} bytes).`);
}

const COMMANDS = { restore, keepalive, publish };

async function main() {
  const command = process.argv[2];
  if (!COMMANDS[command]) {
    console.error('Usage: node scripts/publish.mjs restore|keepalive|publish');
    process.exit(2);
  }
  try {
    await COMMANDS[command](process.env);
  } catch (error) {
    // Never print request headers, environment or subprocess stderr.
    const known = error instanceof StorageError || error instanceof GitError || /^(Publication|Fresh public|Repository lookup|Unexpected|Invalid|Unapproved)/.test(error?.message ?? '');
    const message = `${command} stopped: ${known ? error.message : error?.name ?? 'Error'}`;
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
    }
    console.error(message);
    process.exit(1);
  }
}

await main();
