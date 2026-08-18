import { describe, expect, it } from 'vitest';
import { basename, joinPath, pathSeparator, slugify } from './paths';

describe('pathSeparator', () => {
  it('detects a Windows-style path with backslashes only', () => {
    expect(pathSeparator('C:\\Users\\mark')).toBe('\\');
  });

  it('defaults to forward slash for a POSIX-style path', () => {
    expect(pathSeparator('/home/mark')).toBe('/');
  });

  it('prefers forward slash when a path mixes both separators', () => {
    expect(pathSeparator('C:\\Users/mark')).toBe('/');
  });

  it('defaults to forward slash for a bare name with no separators', () => {
    expect(pathSeparator('project')).toBe('/');
  });
});

describe('joinPath', () => {
  it('joins a POSIX parent and folder', () => {
    expect(joinPath('/home/mark', 'projects')).toBe('/home/mark/projects');
  });

  it('joins a Windows parent and folder using backslashes', () => {
    expect(joinPath('C:\\Users\\mark', 'projects')).toBe('C:\\Users\\mark\\projects');
  });

  it('does not duplicate a trailing separator on the parent', () => {
    expect(joinPath('/home/mark/', 'projects')).toBe('/home/mark/projects');
    expect(joinPath('C:\\Users\\mark\\', 'projects')).toBe('C:\\Users\\mark\\projects');
  });

  it('returns an empty string when either side is empty', () => {
    expect(joinPath('', 'projects')).toBe('');
    expect(joinPath('/home/mark', '')).toBe('');
  });
});

describe('basename', () => {
  it('returns the last POSIX path segment', () => {
    expect(basename('/home/mark/projects')).toBe('projects');
  });

  it('returns the last Windows path segment', () => {
    expect(basename('C:\\Users\\mark\\projects')).toBe('projects');
  });

  it('ignores a trailing separator', () => {
    expect(basename('/home/mark/projects/')).toBe('projects');
    expect(basename('C:\\Users\\mark\\projects\\')).toBe('projects');
  });

  it('returns the whole string when there is no separator', () => {
    expect(basename('projects')).toBe('projects');
  });
});

describe('slugify', () => {
  it('trims and collapses disallowed characters into a single hyphen', () => {
    expect(slugify('  My Cool Project!!  ')).toBe('My-Cool-Project');
  });

  it('keeps letters, digits, dots, underscores, and hyphens as-is', () => {
    expect(slugify('a1_b2.c3-d4')).toBe('a1_b2.c3-d4');
  });

  it('strips leading and trailing hyphens produced by collapsing', () => {
    expect(slugify('***Weird Name***')).toBe('Weird-Name');
  });

  it('returns an empty string for input that is entirely disallowed characters', () => {
    expect(slugify('!!!   ***')).toBe('');
  });
});
