import { describe, expect, it } from 'vitest';
import { assetFolder, filterBySearch, folderContents } from './assetPickerUtils';

describe('filterBySearch', () => {
  const assets = [
    { name: 'motor.png', path: 'images/Line One/motor.png' },
    { name: 'pressure.png', path: 'images/Line Two/pressure.png' },
  ];

  it('requires every query word and allows words in parent paths', () => {
    expect(filterBySearch(assets, 'motor line one', (asset) => asset.path)).toEqual([assets[0]]);
    expect(filterBySearch(assets, 'motor two', (asset) => asset.path)).toEqual([]);
  });
});

describe('assetFolder', () => {
  it('returns the empty string for root-level assets', () => {
    expect(assetFolder('icons/alarm.svg')).toBe('');
  });

  it('returns the nested folder path, excluding the type root and filename', () => {
    expect(assetFolder('images/Line One/motor.png')).toBe('Line One');
    expect(assetFolder('icons/machines/pumps/valve.svg')).toBe('machines/pumps');
  });
});

describe('folderContents', () => {
  const assets = [
    { path: 'images/Line Two/pressure.png' },
    { path: 'images/logo.png' },
    { path: 'images/Line One/motor.png' },
    { path: 'images/Line One/Sub/gauge.png' },
  ];

  it('lists root-level folders and direct files at the root', () => {
    const { folders, files } = folderContents(assets, '');
    expect(folders).toEqual(['Line One', 'Line Two']);
    expect(files).toEqual([assets[1]]);
  });

  it('drills into a folder, collapsing deeper nesting into a child folder name', () => {
    const { folders, files } = folderContents(assets, 'Line One');
    expect(folders).toEqual(['Sub']);
    expect(files).toEqual([assets[2]]);
  });

  it('lists files inside a nested subfolder', () => {
    const { folders, files } = folderContents(assets, 'Line One/Sub');
    expect(folders).toEqual([]);
    expect(files).toEqual([assets[3]]);
  });
});
