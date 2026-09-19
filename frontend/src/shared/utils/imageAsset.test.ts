import { describe, expect, it } from 'vitest';
import { imageAssetUrl, imageBodyToUrl, resolveImageSrc } from './imageAsset';

describe('imageAssetUrl', () => {
  it('prefixes a bare filename with the images folder', () => {
    expect(imageAssetUrl('logo.png')).toBe('/assets/images/logo.png');
  });

  it('passes a path already rooted at a known asset folder through', () => {
    expect(imageAssetUrl('images/logo.png')).toBe('/assets/images/logo.png');
    expect(imageAssetUrl('icons/pump.svg')).toBe('/assets/icons/pump.svg');
    expect(imageAssetUrl('videos/clip.mp4')).toBe('/assets/videos/clip.mp4');
  });

  it('returns an absolute URL untouched', () => {
    expect(imageAssetUrl('https://cdn.example.com/logo.svg')).toBe(
      'https://cdn.example.com/logo.svg',
    );
    expect(imageAssetUrl('http://cdn.example.com/logo.svg')).toBe(
      'http://cdn.example.com/logo.svg',
    );
    expect(imageAssetUrl('data:image/svg+xml;base64,AAAA')).toBe('data:image/svg+xml;base64,AAAA');
    expect(imageAssetUrl('blob:http://localhost/9f1c')).toBe('blob:http://localhost/9f1c');
  });
});

describe('imageBodyToUrl', () => {
  it('resolves the path of an asset payload', () => {
    expect(imageBodyToUrl({ path: 'videos/clip.mp4' })).toBe('/assets/videos/clip.mp4');
  });

  it('returns null without a usable path', () => {
    expect(imageBodyToUrl(null)).toBeNull();
    expect(imageBodyToUrl(undefined)).toBeNull();
    expect(imageBodyToUrl({})).toBeNull();
    expect(imageBodyToUrl({ path: '' })).toBeNull();
    expect(imageBodyToUrl({ path: 42 })).toBeNull();
  });
});

describe('resolveImageSrc', () => {
  it('unwraps a $static payload and passes plain strings through', () => {
    expect(resolveImageSrc({ $static: { path: 'images/logo.png' } })).toBe(
      '/assets/images/logo.png',
    );
    expect(resolveImageSrc('https://cdn.example.com/logo.svg')).toBe(
      'https://cdn.example.com/logo.svg',
    );
    expect(resolveImageSrc(null)).toBeNull();
  });
});
