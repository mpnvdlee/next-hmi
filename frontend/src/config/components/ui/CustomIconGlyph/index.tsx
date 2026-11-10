import type { CSSProperties } from 'react';
import { withBase } from '@shared/utils/runtimeBase';
import './style.css';

/**
 * A custom (SVG file) icon the way the widgets draw it: the current text colour
 * seen through the file as a CSS mask, not the file's own paint. An editor
 * preview drawn as an image would show colours the screen never will.
 */
export default function CustomIconGlyph({ path, size }: { path: string; size: number }) {
  // Encoded, so no character of a file name can end the CSS string.
  const url = withBase(`/assets/${encodeURI(path.replace(/^\/?assets\//, ''))}`);
  return (
    <span
      className="cfg-custom-icon"
      aria-hidden="true"
      style={
        {
          '--cfg-custom-icon-url': `url("${url}")`,
          '--cfg-custom-icon-size': `${size}px`,
        } as CSSProperties
      }
    />
  );
}
