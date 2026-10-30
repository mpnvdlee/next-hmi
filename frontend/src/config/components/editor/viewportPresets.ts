import { DeviceMobile, DeviceTablet, FrameCorners, Laptop } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { EditorViewport } from '@shared/types/config';

interface ViewportPreset {
  id: string;
  label: string;
  w: number;
  h: number;
  icon: Icon;
}

export const VIEWPORTS: ReadonlyArray<ViewportPreset> = [
  { id: 'fit', label: 'Fit to screen', w: 0, h: 0, icon: FrameCorners },
  { id: 'laptop', label: 'Laptop', w: 1440, h: 900, icon: Laptop },
  { id: 'tablet', label: 'Tablet', w: 1024, h: 768, icon: DeviceTablet },
  { id: 'phone', label: 'Phone', w: 390, h: 844, icon: DeviceMobile },
];

/** Selector index of the custom-size button, after the presets. */
export const CUSTOM_VIEWPORT = VIEWPORTS.length;

/** `idx` picks a preset or CUSTOM_VIEWPORT; `w`/`h` are the custom size. */
export interface ViewportChoice {
  idx: number;
  w: number;
  h: number;
}

const VIEWPORT_DEFAULT: ViewportChoice = { idx: 0, w: 1920, h: 1080 };
const SIDE_MIN = 200;
const SIDE_MAX = 7680;

export function clampViewportSide(px: number) {
  return Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(px)));
}

// The project file names the preset rather than its selector index, so
// reordering the buttons never changes what a saved project opens with.
const CUSTOM_ID = 'custom';

/** Reads `shell.editorViewport`; a missing, hand-edited or unknown value falls back per field. */
export function viewportFromShell(saved: EditorViewport | undefined): ViewportChoice {
  if (!saved) return VIEWPORT_DEFAULT;
  const preset = VIEWPORTS.findIndex((v) => v.id === saved.preset);
  const idx = saved.preset === CUSTOM_ID ? CUSTOM_VIEWPORT : Math.max(preset, 0);
  const side = (px: unknown, fallback: number) =>
    typeof px === 'number' && Number.isFinite(px) ? clampViewportSide(px) : fallback;
  return {
    idx,
    w: side(saved.width, VIEWPORT_DEFAULT.w),
    h: side(saved.height, VIEWPORT_DEFAULT.h),
  };
}

export function viewportToShell(choice: ViewportChoice): EditorViewport {
  const preset = choice.idx === CUSTOM_VIEWPORT ? CUSTOM_ID : VIEWPORTS[choice.idx].id;
  return { preset, width: choice.w, height: choice.h };
}
