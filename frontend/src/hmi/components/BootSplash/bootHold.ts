import { useEffect, useState } from 'react';

/**
 * Minimum time the splash stays up on a page load, so it reads as a boot screen.
 *
 * Also the window in which the attribution notice is legible, so the number is
 * documented in COMMERCIAL.md: shortening it without a commercial licence is a
 * licence violation, the same as hiding the notice outright.
 */
const MIN_SPLASH_MS = 2000;

// Module load is the earliest wall-clock we can attribute to this page load.
const BOOT_STARTED_AT = Date.now();

// Deliberately module state, not sessionStorage: it resets with the page, so
// the splash replays on every load and reload of the HMI, and is skipped only
// for route changes within the load that already paid for it. Operators switch
// pages constantly — a boot screen between them would be unusable.
let booted = false;

/** Record that this page load has booted, so route changes don't replay the splash. */
export function markBooted(): void {
  booted = true;
}

/** Test-only: forget that this page load already booted. */
export function resetBootHold(): void {
  booted = false;
}

/**
 * Whether the boot splash must stay on screen even though the app is ready.
 *
 * One floor, {@link MIN_SPLASH_MS} from page load, skipped once this page load
 * has booted. The caller still holds the splash until whatever it is waiting
 * for has landed — this only sets the shortest the screen may appear for.
 */
export function useBootHold(): boolean {
  const [floorDone, setFloorDone] = useState(booted);

  useEffect(() => {
    if (floorDone) return;
    const remaining = MIN_SPLASH_MS - (Date.now() - BOOT_STARTED_AT);
    if (remaining <= 0) {
      setFloorDone(true);
      return;
    }
    const timer = setTimeout(() => setFloorDone(true), remaining);
    return () => clearTimeout(timer);
  }, [floorDone]);

  return !floorDone;
}
