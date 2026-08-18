import type { AlarmDefinition, AlarmGroup } from '@shared/types/alarm';
import { matchesSearchWords, withDotSearchSeparators } from '@shared/utils/search';
import { resolveAlarmString } from './alarmDisplayUtils';

/** The row label the tree shows for an alarm — code prefix included, so a search for a code hits. */
export function alarmTreeLabel(alarm: AlarmDefinition): string {
  const title = resolveAlarmString(alarm.title) || 'Untitled';
  return alarm.code ? `[${alarm.code}] ${title}` : title;
}

/** The row label the tree shows for a group. */
export function alarmGroupTreeLabel(group: AlarmGroup): string {
  return group.title || 'Untitled Group';
}

/**
 * Filter the alarm tree against a search.
 *
 * A group matched by title keeps all of its alarms, the way a matched folder
 * shows its whole subtree; otherwise only the alarms that matched survive, and
 * a group nothing matched in is dropped. Query words may span the group title
 * and the alarm label, so "tank overflow" finds the alarm inside "Tank".
 */
export function filterAlarmGroups(groups: AlarmGroup[], query: string): AlarmGroup[] {
  if (!query.trim()) return groups;
  const wordQuery = withDotSearchSeparators(query);

  const kept: AlarmGroup[] = [];
  for (const group of groups) {
    const groupLabel = alarmGroupTreeLabel(group);
    if (matchesSearchWords(wordQuery, groupLabel)) {
      kept.push(group);
      continue;
    }
    const alarms = group.alarms.filter((alarm) =>
      matchesSearchWords(wordQuery, [groupLabel, alarmTreeLabel(alarm)]),
    );
    if (alarms.length > 0) kept.push({ ...group, alarms });
  }
  return kept;
}
