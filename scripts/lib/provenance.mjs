// Run provenance and the publication context check (ported from the siblings).
import { REPOSITORY, DEFAULT_BRANCH } from './constants.mjs';

const EVENTS = ['schedule', 'push', 'workflow_dispatch'];
const HEX40 = /^[0-9a-f]{40}$/;

export function runProvenance(env, startedAt) {
  if (env.GITHUB_ACTIONS !== 'true') return { event: 'local', startedAt };
  if (env.GITHUB_REPOSITORY !== REPOSITORY) throw new Error('Unexpected repository context');
  const id = env.GITHUB_RUN_ID ?? '';
  const attempt = env.GITHUB_RUN_ATTEMPT ?? '';
  const sha = env.GITHUB_SHA ?? '';
  if (!/^\d+$/.test(id) || !/^\d+$/.test(attempt) || !HEX40.test(sha)) throw new Error('Invalid runner provenance');
  if (!EVENTS.includes(env.GITHUB_EVENT_NAME)) throw new Error('Unapproved workflow event');
  return {
    event: env.GITHUB_EVENT_NAME,
    startedAt,
    id,
    attempt: Number(attempt),
    headSha: sha,
    url: `https://github.com/${REPOSITORY}/actions/runs/${id}`,
  };
}

export function checkActionsContext(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== REPOSITORY || !EVENTS.includes(env.GITHUB_EVENT_NAME) || env.GITHUB_REF !== `refs/heads/${DEFAULT_BRANCH}`) {
    throw new Error('Publication is restricted to the approved public GitHub workflow on main');
  }
}

// Fresh visibility and size from the GitHub API (size is reported in KiB).
export async function fetchRepository(token, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'bank-run-map-data/1.0',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (response.status !== 200 || text.length > 200_000) throw new Error(`Repository lookup failed (HTTP ${response.status})`);
  const repository = JSON.parse(text);
  if (repository.full_name !== REPOSITORY || repository.private !== false || repository.visibility !== 'public'
      || !Number.isInteger(repository.size) || repository.default_branch !== DEFAULT_BRANCH) {
    throw new Error('Fresh public repository identity, visibility and size must be established');
  }
  return { sizeBytes: repository.size * 1024, defaultBranch: repository.default_branch };
}
