// Minimal git transport for the public-data branch and the keepalive commit.
// The token reaches git only through GIT_CONFIG_* environment variables of the
// push process: never a file, a remote URL, a log line or the collector process.
import { execFileSync } from 'node:child_process';
import { REPOSITORY } from './constants.mjs';

export const REMOTE_URL = `https://github.com/${REPOSITORY}.git`;
export const BOT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'Bank Run Map public-data collector',
  GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'Bank Run Map public-data collector',
  GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
});

export class GitError extends Error {
  constructor(message) { super(message); this.name = 'GitError'; }
}

export function git(args, { env = {}, input, cwd } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // Never echo stderr: it can contain request headers on some failures.
    throw new GitError(`git ${args[0]} failed (exit ${error.status ?? 'unknown'})`);
  }
}

export const gitText = (args, options) => git(args, options).toString('utf8').trim();

export function pushEnv(token) {
  if (!token) throw new GitError('The workflow repository token is required to push');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    GIT_TRACE: '0',
    GIT_TRACE_CURL: '0',
    GIT_CURL_VERBOSE: '0',
  };
}

// Returns the remote branch head, or null only when the branch provably does not exist.
export function remoteHead(branch, { cwd } = {}) {
  const output = gitText(['ls-remote', '--heads', REMOTE_URL, `refs/heads/${branch}`], { cwd });
  if (!output) return null;
  const [sha, ref] = output.split(/\s+/);
  if (!/^[0-9a-f]{40}$/.test(sha) || ref !== `refs/heads/${branch}`) throw new GitError('Unexpected ls-remote output');
  return sha;
}

export function fetchBranch(branch, localRef, { cwd } = {}) {
  git(['fetch', '--no-tags', '--depth=1', REMOTE_URL, `+refs/heads/${branch}:${localRef}`], { cwd });
  return gitText(['rev-parse', '--verify', `${localRef}^{commit}`], { cwd });
}

// Lists a commit's files; only regular non-executable blobs are acceptable.
export function listTree(commit, { cwd } = {}) {
  const raw = git(['ls-tree', '-r', '-l', '-z', commit], { cwd }).toString('utf8');
  return raw.split('\0').filter(Boolean).map((line) => {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40}) +(\d+|-)\t(.+)$/.exec(line);
    if (!match) throw new GitError('Unexpected ls-tree output');
    return { mode: match[1], type: match[2], sha: match[3], size: Number(match[4]), path: match[5] };
  });
}
