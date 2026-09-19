import { describe, expect, it } from 'vitest';
import { freeFolderName, sameParams, type TransferParams } from './peerTransferParams';

describe('freeFolderName', () => {
  it('keeps a name nothing holds', () => {
    expect(freeFolderName('landing', new Set())).toBe('landing');
  });

  it('trims before deciding, so " landing " is the taken "landing"', () => {
    expect(freeFolderName(' landing ', new Set(['landing']))).toBe('landing-2');
  });

  it('counts from 2 and skips every name already taken', () => {
    expect(freeFolderName('landing', new Set(['landing', 'landing-2', 'landing-3']))).toBe(
      'landing-4',
    );
  });

  it('falls back to a name for an empty base', () => {
    expect(freeFolderName('   ', new Set())).toBe('project');
  });

  it('gives up counting and appends a random suffix rather than looping forever', () => {
    const taken = new Set(['landing']);
    for (let index = 2; index < 1000; index += 1) taken.add(`landing-${index}`);
    expect(freeFolderName('landing', taken)).toMatch(/^landing-[0-9a-f]{8}$/);
  });
});

describe('sameParams', () => {
  const base: TransferParams = {
    sourceProjectId: 'p1',
    destinationFolder: 'landing',
    collisionPolicy: 'reject',
    replacementId: '',
    confirmReplace: false,
    start: false,
  };

  it('holds for an unchanged form, so the transfer id can be reused', () => {
    expect(sameParams(base, { ...base })).toBe(true);
  });

  it.each([
    ['sourceProjectId', { sourceProjectId: 'p2' }],
    ['destinationFolder', { destinationFolder: 'landing-2' }],
    ['collisionPolicy', { collisionPolicy: 'copy' as const }],
    ['replacementId', { replacementId: 'p9' }],
    ['confirmReplace', { confirmReplace: true }],
    ['start', { start: true }],
  ])('sees a changed %s, which the backend would refuse under the same id', (_field, change) => {
    expect(sameParams(base, { ...base, ...change })).toBe(false);
  });
});
