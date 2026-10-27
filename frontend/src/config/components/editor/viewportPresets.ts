import { DeviceMobile, DeviceTablet, FrameCorners, Laptop } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';

interface ViewportPreset {
  label: string;
  w: number;
  h: number;
  icon: Icon;
}

export const VIEWPORTS: ReadonlyArray<ViewportPreset> = [
  { label: 'Fit to screen', w: 0, h: 0, icon: FrameCorners },
  { label: 'Laptop', w: 1440, h: 900, icon: Laptop },
  { label: 'Tablet', w: 1024, h: 768, icon: DeviceTablet },
  { label: 'Phone', w: 390, h: 844, icon: DeviceMobile },
];

/** Selector index of the custom-size button, after the presets. */
export const CUSTOM_VIEWPORT = VIEWPORTS.length;

/** `idx` picks a preset or CUSTOM_VIEWPORT; `w`/`h` are the custom size. */
export interface ViewportChoice {
  idx: number;
  w: number;
  h: number;
}

const VIEWPORT_KEY = 'cfg-preview:viewport';
const VIEWPORT_DEFAULT: ViewportChoice = { idx: 0, w: 1920, h: 1080 };
const SIDE_MIN = 200;
const SIDE_MAX = 7680;

export function clampViewportSide(px: number) {
  return Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(px)));
}

export function storedViewport(): ViewportChoice {
  try {
    const v = JSON.parse(window.localStorage.getItem(VIEWPORT_KEY) ?? 'null');
    if (
      Number.isInteger(v?.idx) &&
      v.idx >= 0 &&
      v.idx <= CUSTOM_VIEWPORT &&
      Number.isFinite(v.w) &&
      Number.isFinite(v.h)
    ) {
      return { idx: v.idx, w: clampViewportSide(v.w), h: clampViewportSide(v.h) };
    }
  } catch {
    /* blocked storage or a corrupt value — fall back to the default */
  }
  return VIEWPORT_DEFAULT;
}

export function storeViewport(choice: ViewportChoice) {
  try {
    window.localStorage.setItem(VIEWPORT_KEY, JSON.stringify(choice));
  } catch {
    /* private mode / quota — the viewport just won't be remembered */
  }
}
