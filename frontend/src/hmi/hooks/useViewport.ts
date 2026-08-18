import { useSyncExternalStore } from 'react';
import {
  DEFAULT_VIEWPORT_BREAKPOINTS,
  classifyViewport,
  type ViewportBreakpoints,
} from '@shared/utils/viewport';
import type { ViewportSize } from '@shared/types/config';

interface ViewportState {
  size: ViewportSize;
  width: number;
  height: number;
  orientation: 'portrait' | 'landscape';
}

function readViewport(bp: ViewportBreakpoints): ViewportState {
  if (typeof window === 'undefined') {
    return { size: 'laptop', width: 1280, height: 720, orientation: 'landscape' };
  }
  const width = window.innerWidth;
  const height = window.innerHeight;
  return {
    size: classifyViewport(width, bp),
    width,
    height,
    orientation: width >= height ? 'landscape' : 'portrait',
  };
}

// Singleton subscription — one resize/orientationchange listener total, regardless
// of how many components call useViewport. Each useViewport caller subscribes via
// useSyncExternalStore, so re-renders only fire when the snapshot actually changes.
const breakpoints = DEFAULT_VIEWPORT_BREAKPOINTS;
let snapshot: ViewportState = readViewport(breakpoints);
const listeners = new Set<() => void>();
let installed = false;

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  let frame = 0;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const next = readViewport(breakpoints);
      if (
        snapshot.size === next.size &&
        snapshot.width === next.width &&
        snapshot.height === next.height &&
        snapshot.orientation === next.orientation
      ) {
        return;
      }
      snapshot = next;
      listeners.forEach((l) => l());
    });
  };
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
}

const subscribe = (cb: () => void): (() => void) => {
  install();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const getSnapshot = (): ViewportState => snapshot;

export function useViewport(): ViewportState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export const getViewportSnapshot = (): ViewportState => snapshot;
