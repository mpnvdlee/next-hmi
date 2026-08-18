import { useEffect } from 'react';

const ZOOM_KEYS = new Set(['+', '-', '=', '0']);

/** Blocks browser-native pinch/ctrl-wheel zoom and the Ctrl/Cmd +/-/0 zoom
 *  shortcuts, plus Safari's non-standard gesture events. Config surfaces and
 *  the live preview provide their own scaling controls, so an accidental
 *  trackpad pinch or Ctrl+wheel must not fight that with a second, browser-level
 *  zoom on top. Normal (non-ctrl) wheel scrolling is left untouched. */
export function useDisableBrowserZoom() {
  useEffect(() => {
    function handleWheel(e: WheelEvent) {
      if (e.ctrlKey) e.preventDefault();
    }
    function handleGesture(e: Event) {
      e.preventDefault();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && ZOOM_KEYS.has(e.key)) e.preventDefault();
    }
    window.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('gesturestart', handleGesture);
    window.addEventListener('gesturechange', handleGesture);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('wheel', handleWheel);
      window.removeEventListener('gesturestart', handleGesture);
      window.removeEventListener('gesturechange', handleGesture);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);
}
