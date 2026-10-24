import type { TelemetryStatus } from './index';

const CONTACT_URL = 'https://next-hmi.com/contact';

/** The contact form, pre-filled with the installation ID only while reports are being sent:
 *  without them the ID matches nothing at the far end. */
export function contactUrl(status: TelemetryStatus): string {
  const query = new URLSearchParams({ from: 'app' });
  if (status.enabled) query.set('install', status.installId);
  return `${CONTACT_URL}?${query}`;
}
