/**
 * `navigator.clipboard` is a secure-context-only API, so an installation reached
 * over plain HTTP on a LAN address (`http://192.168.1.10:8000`) has no clipboard
 * at all and every copy and paste fails. Calling that "blocked" sends the
 * operator to the browser's permission prompt, which cannot grant what the page
 * was never given — so name the real cause when the API is absent, and keep
 * "blocked" for a genuine denial.
 */
const clipboardMissing = (): boolean =>
  typeof navigator === 'undefined' || navigator.clipboard == null;

const UNAVAILABLE = 'Clipboard needs HTTPS or localhost';

export const clipboardWriteError = (): string =>
  clipboardMissing() ? UNAVAILABLE : 'Clipboard write blocked';

export const clipboardReadError = (): string =>
  clipboardMissing() ? UNAVAILABLE : 'Clipboard read blocked';
