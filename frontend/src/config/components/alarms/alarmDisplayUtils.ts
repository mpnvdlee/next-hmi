import type { AlarmConfig, AlarmDefinition } from '@shared/types/alarm';
import { evaluatePropertyValue } from '@hmi/utils/propertySourceEval';
import { useTranslationStore } from '@shared/store/translationStore';

/**
 * Resolve a displayable string from an alarm text field. This side of the app
 * holds the authored value, so `$loc` still carries its wrapper and resolves
 * against the dictionary — the preview has to read the way the live view does.
 * `$stringExpr` templates keep unresolved `{n}` placeholders intact (there is no
 * runtime context here), and unknown wrappers yield ''.
 *
 * Callers that must survive a language switch should also subscribe to
 * `activeLanguage` — this reads the store at call time and cannot re-render.
 */
export function resolveAlarmString(value: unknown): string {
  const result = evaluatePropertyValue(value, {
    resolveTranslation: (key) => useTranslationStore.getState().resolve(key),
  });
  return result == null ? '' : String(result);
}

/**
 * Resolve an asset-relative image path from an alarm image field.
 * Returns a path suitable for passing to `assetUrl()`, or '' when none is set.
 *
 * Handles:
 * - Plain string            → "images/<name>"
 * - `{ $static: <name> }`    → "images/<name>"
 * - `{ $static: { path } }`  → path as-is
 */
export function resolveAlarmImage(value: unknown): string {
  if (typeof value === 'string' && value) return `images/${value}`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$static === 'string' && obj.$static) return `images/${obj.$static}`;
    if (obj.$static !== null && typeof obj.$static === 'object') {
      const img = obj.$static as Record<string, unknown>;
      if (typeof img.path === 'string') return img.path;
    }
  }
  return '';
}

/**
 * Find an alarm definition by id across all groups.
 * Returns undefined when not found.
 */
export function findAlarm(config: AlarmConfig, id: string): AlarmDefinition | undefined {
  for (const g of config.groups) {
    const a = g.alarms.find((a) => a.id === id);
    if (a) return a;
  }
  return undefined;
}
