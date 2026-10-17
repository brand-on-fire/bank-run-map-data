// GitHub disables schedules in public repositories after 60 days without
// activity. The job commits a dated heartbeat to main at most once per 30 days,
// counting from the later of the last heartbeat (committed state) and the
// newest commit on main. keepalive/ is outside the workflow push path filter.
import { DAY } from './constants.mjs';

export const HEARTBEAT_PATH = 'keepalive/HEARTBEAT.md';

export function keepaliveDue({ nowMs, lastCommittedAt, mainHeadCommittedAt, intervalDays }) {
  const last = Math.max(Date.parse(lastCommittedAt ?? '') || 0, Date.parse(mainHeadCommittedAt ?? '') || 0);
  return nowMs - last >= intervalDays * DAY;
}

export function heartbeatContent({ nowIso, runUrl }) {
  return [
    '# Collector heartbeat',
    '',
    `Last heartbeat: ${nowIso}${runUrl ? ` (${runUrl})` : ''}`,
    '',
    'The scheduled collector rewrites this file at most once every 30 days so GitHub keeps the',
    'schedule enabled (schedules in public repositories are disabled after 60 days without',
    'activity). This path is outside the workflow push filter, so it never triggers a run.',
    '',
  ].join('\n');
}
