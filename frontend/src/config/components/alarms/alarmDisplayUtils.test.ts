import { describe, expect, it, afterEach } from 'vitest';
import { useTranslationStore } from '@shared/store/translationStore';
import { resolveAlarmString } from './alarmDisplayUtils';

const original = useTranslationStore.getState();

afterEach(() => {
  useTranslationStore.setState(original, true);
});

function seedDictionary(activeLanguage: string) {
  useTranslationStore.setState({
    languages: [{ code: 'en-EN' }, { code: 'de-DE' }],
    translations: { Measurement: { 'en-EN': 'Measurement', 'de-DE': 'Messung' } },
    activeLanguage,
  });
}

describe('resolveAlarmString', () => {
  it('resolves a $loc alarm title against the dictionary', () => {
    seedDictionary('de-DE');
    expect(resolveAlarmString({ $loc: 'Measurement' })).toBe('Messung');
  });

  it('renders the key in the base language, where keys are the text', () => {
    seedDictionary('en-EN');
    expect(resolveAlarmString({ $loc: 'Measurement' })).toBe('Measurement');
  });

  it('falls back to the key when the dictionary has no entry', () => {
    seedDictionary('de-DE');
    expect(resolveAlarmString({ $loc: 'alarm.unknown' })).toBe('alarm.unknown');
  });

  it('passes plain and $static titles through untouched', () => {
    seedDictionary('de-DE');
    expect(resolveAlarmString('Tank B level low')).toBe('Tank B level low');
    expect(resolveAlarmString({ $static: 'Tank B level low' })).toBe('Tank B level low');
  });

  it('yields an empty string for an unset title', () => {
    seedDictionary('de-DE');
    expect(resolveAlarmString(undefined)).toBe('');
  });
});
