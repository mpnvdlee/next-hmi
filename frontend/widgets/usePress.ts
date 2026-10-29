/**
 * Press on pointer-down or Enter/Space down; release exactly once per press —
 * on pointer-up, a cancelled touch, lost capture, key-up or unmount. Capture
 * keeps the release on this element when the finger slides off it, so a
 * momentary write never stays stuck at true.
 *
 * `accepts` filters which events start a press (a pressable Container leaves
 * presses on the controls inside it to them).
 */

/** The press already acted on pointer-down, so the click the browser sends after
 *  pointer-up belongs to nobody. A touch click is hit-tested where the finger
 *  lifted, so it would land on whatever the press just opened — a dialog's
 *  backdrop, which closes on click. */
function swallowNextClick() {
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  document.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 500);
}

export function usePress(
  onPress: (el: HTMLElement) => void,
  onRelease: (el: HTMLElement) => void,
  accepts: (e: { target: EventTarget; currentTarget: HTMLElement }) => boolean = () => true,
) {
  const held = useRef<HTMLElement | null>(null);
  const releaseRef = useRef(onRelease);
  releaseRef.current = onRelease;
  const release = useCallback(() => {
    const el = held.current;
    if (!el) return;
    held.current = null;
    releaseRef.current(el);
  }, []);
  useEffect(() => release, [release]);

  const press = (el: HTMLElement) => {
    if (held.current) return;
    held.current = el;
    onPress(el);
  };

  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !accepts(e)) return;
      // Throws for a pointer that is not down, such as a backdrop's forwarded tap.
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        /* no capture: release still comes from pointer-up */
      }
      press(e.currentTarget);
    },
    onPointerUp: () => {
      if (held.current) swallowNextClick();
      release();
    },
    onPointerCancel: release,
    onLostPointerCapture: release,
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.repeat || (e.key !== 'Enter' && e.key !== ' ') || !accepts(e)) return;
      e.preventDefault();
      press(e.currentTarget);
    },
    onKeyUp: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter' || e.key === ' ') release();
    },
  };
}
