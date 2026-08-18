import { describe, expect, it } from 'vitest';
import type { AlarmDefinition, AlarmGroup } from '@shared/types/alarm';
import { alarmTreeLabel, filterAlarmGroups } from './alarmSearch';

function alarm(id: string, code: string, title: unknown): AlarmDefinition {
  return {
    id,
    code,
    level: 'error',
    title,
    description: '',
    image: '',
    auto_popup: false,
    resolutions: [],
    trigger: { type: 'bool', source_value: undefined, min: null, max: null, on_true: true },
    ack_groups: [],
  };
}

const overflow = alarm('overflow', 'A1', 'Tank Overflow');
const dry = alarm('dry', 'A2', 'Running Dry');
const overheat = alarm('overheat', 'B1', 'Motor Overheat');

const tank: AlarmGroup = { id: 'tank', title: 'Tank', alarms: [overflow, dry] };
const pump: AlarmGroup = { id: 'pump', title: 'Pump', alarms: [overheat] };
const groups = [tank, pump];

describe('alarmTreeLabel', () => {
  it('prefixes the code the way the tree row renders it', () => {
    expect(alarmTreeLabel(overflow)).toBe('[A1] Tank Overflow');
  });

  it('falls back to Untitled and drops an empty code', () => {
    expect(alarmTreeLabel(alarm('x', '', ''))).toBe('Untitled');
  });

  it('resolves a $static title wrapper', () => {
    expect(alarmTreeLabel(alarm('x', '', { $static: 'Wrapped' }))).toBe('Wrapped');
  });
});

describe('filterAlarmGroups', () => {
  it('returns the input untouched for an empty query', () => {
    expect(filterAlarmGroups(groups, '  ')).toBe(groups);
  });

  it('keeps every alarm of a group matched by title', () => {
    expect(filterAlarmGroups(groups, 'tank')).toEqual([tank]);
  });

  it('keeps only the alarms that matched inside an unmatched group', () => {
    const result = filterAlarmGroups(groups, 'dry');
    expect(result).toHaveLength(1);
    expect(result[0].alarms).toEqual([dry]);
  });

  it('matches on the alarm code', () => {
    const result = filterAlarmGroups(groups, 'b1');
    expect(result).toHaveLength(1);
    expect(result[0].alarms).toEqual([overheat]);
  });

  it('spans the group title and the alarm label', () => {
    const result = filterAlarmGroups(groups, 'pump overheat');
    expect(result).toHaveLength(1);
    expect(result[0].alarms).toEqual([overheat]);
  });

  it('drops groups nothing matched in', () => {
    expect(filterAlarmGroups(groups, 'valve')).toEqual([]);
  });
});
