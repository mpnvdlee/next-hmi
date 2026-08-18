export const APP_NAME = 'NEXT HMI';

/**
 * The document title for a given subtitle: `"NEXT HMI - Foo"`, or `undefined`
 * when there's no subtitle (so callers can fall back to the app name / original
 * title). Single source for the app-name prefix used by `useDocumentChrome`
 * (config-driven `appTitle`) and `useDocumentTitle` (manager pages) — the two
 * run on mutually exclusive surfaces, so this shares only the format, not state.
 */
export function withAppName(subtitle?: string | null): string | undefined {
  const trimmed = subtitle?.trim();
  return trimmed ? `${APP_NAME} - ${trimmed}` : undefined;
}
