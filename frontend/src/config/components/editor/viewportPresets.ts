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
