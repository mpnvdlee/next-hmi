import type { IconValue } from '@shared/types/config';

export function isIconValue(value: unknown): value is IconValue {
  if (!value || typeof value !== 'object') return false;
  const icon = value as Record<string, unknown>;
  if (icon.type === 'builtin') {
    return (
      Object.keys(icon).length === 2 && typeof icon.name === 'string' && icon.name.trim().length > 0
    );
  }
  if (icon.type === 'custom') {
    return (
      Object.keys(icon).length === 2 && typeof icon.path === 'string' && icon.path.trim().length > 0
    );
  }
  return false;
}

export function iconValueLabel(icon: IconValue): string {
  if (icon.type === 'builtin') return icon.name;
  const segments = icon.path.split('/');
  return segments[segments.length - 1] || icon.path;
}
