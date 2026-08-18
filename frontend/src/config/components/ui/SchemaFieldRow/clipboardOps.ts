import type { SchemaField } from '@shared/types/widgetSchema';
import {
  isPropertySourceAllowed,
  SCOPE_SOURCES,
  SOURCE_CAPABLE_TYPES,
} from '@hmi/utils/propertySourceRules';
import { isPropertySourceKey } from '@hmi/utils/propertySourceRegistry';
import { primaryType } from '@shared/utils/valueTypes';
import { useHmiStore } from '@hmi/store/hmiStore';
import { hasPropertySourceKey, isRecord } from '@shared/types/propertyValueGuards';
import { getPropertySource } from '@config/components/editor/propertyValueUtils';
import { ACTION_TYPES } from '@config/components/editor/PropertiesPanel/actionsPreview';

function toast(severity: 'info' | 'error', message: string): void {
  useHmiStore.getState().showToast({
    id: crypto.randomUUID(),
    message,
    severity,
    discard: 'auto',
    duration: 2500,
  });
}

const EXPECTED_TYPEOF: Record<string, string> = {
  string: 'string',
  datetime: 'string',
  color: 'string',
  url: 'string',
  icon: 'string',
  image: 'string',
  select: 'string',
  integer: 'number',
  float: 'number',
  boolean: 'boolean',
};

function normalizeForClipboard(value: unknown): unknown {
  return hasPropertySourceKey(value) ? value : { $static: value };
}

// Scope-injected sources: the offer-time source matrix omits them because
// their availability is decided by ambient editor scope (component-property
// scope / action-result handler), not the field type — the PropertySourceSelector
// appends them at render time. They produce `any`, so a copied binding pastes
// into any source-capable field; scope correctness is the operator's call.
function isScopePasteSource(sourceKey: string, fieldType: string): boolean {
  return (
    isPropertySourceKey(sourceKey) &&
    SCOPE_SOURCES.has(sourceKey) &&
    SOURCE_CAPABLE_TYPES.has(fieldType.toLowerCase())
  );
}

export async function copyPropertyValue(value: unknown, label: string): Promise<void> {
  const json = JSON.stringify(normalizeForClipboard(value), null, 2);
  try {
    await navigator.clipboard.writeText(json);
    toast('info', `Copied ${label}`);
  } catch {
    toast('error', 'Clipboard write blocked');
  }
}

export async function pastePropertyValue(
  schema: SchemaField,
  label: string,
  onChange: (value: unknown) => void,
): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    toast('error', 'Clipboard read blocked');
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    toast('error', 'Clipboard is not valid JSON');
    return;
  }

  const detected = getPropertySource(parsed);
  const sourceKey = detected === 'static' || detected == null ? '$static' : detected;
  const fieldType = primaryType(schema.type);
  const check = isPropertySourceAllowed(fieldType, sourceKey);
  if (!check.valid && !isScopePasteSource(sourceKey, fieldType)) {
    toast('error', check.reason ?? 'Incompatible value');
    return;
  }

  const finalValue =
    isRecord(parsed) && '$static' in parsed ? (parsed as { $static: unknown }).$static : parsed;

  if (sourceKey === '$static') {
    const expected = EXPECTED_TYPEOF[primaryType(schema.type)];
    if (expected && typeof finalValue !== expected) {
      toast('error', `Expected ${expected}, got ${typeof finalValue}`);
      return;
    }
  }

  onChange(finalValue);
  toast('info', `Pasted into ${label}`);
}

const ACTION_TYPE_NAMES = new Set<string>(ACTION_TYPES.map((t) => t.type));

export async function pasteActionValue(
  label: string,
  onChange: (value: unknown) => void,
): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    toast('error', 'Clipboard read blocked');
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    toast('error', 'Clipboard is not valid JSON');
    return;
  }

  const unwrapped =
    isRecord(parsed) && '$static' in parsed ? (parsed as { $static: unknown }).$static : parsed;

  if (
    !isRecord(unwrapped) ||
    typeof unwrapped.type !== 'string' ||
    !ACTION_TYPE_NAMES.has(unwrapped.type)
  ) {
    toast('error', 'Clipboard does not contain an action');
    return;
  }

  onChange(unwrapped);
  toast('info', `Pasted into ${label}`);
}
