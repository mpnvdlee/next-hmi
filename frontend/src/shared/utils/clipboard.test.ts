import { describe, it, expect, afterEach } from 'vitest';
import { clipboardReadError, clipboardWriteError } from './clipboard';

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

describe('clipboard error messages', () => {
  afterEach(() => {
    setClipboard({ writeText: () => Promise.resolve(), readText: () => Promise.resolve('') });
  });

  it('blames the browser permission when the API exists', () => {
    setClipboard({ writeText: () => Promise.resolve(), readText: () => Promise.resolve('') });
    expect(clipboardWriteError()).toBe('Clipboard write blocked');
    expect(clipboardReadError()).toBe('Clipboard read blocked');
  });

  it('names the secure-context requirement when the API is absent', () => {
    // What a plain-HTTP LAN install gets: no secure context, so no clipboard.
    setClipboard(undefined);
    expect(clipboardWriteError()).toBe('Clipboard needs HTTPS or localhost');
    expect(clipboardReadError()).toBe('Clipboard needs HTTPS or localhost');
  });
});
