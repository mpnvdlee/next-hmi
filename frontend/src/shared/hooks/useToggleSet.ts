import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * State for a Set<T> with a toggle helper.
 * Returns [set, toggle, setState] — `setState` is exposed for cases that
 * need to replace or initialize from external data.
 */
export function useToggleSet<T>(
  initial?: Iterable<T>,
): [Set<T>, (item: T) => void, Dispatch<SetStateAction<Set<T>>>] {
  const [state, setState] = useState<Set<T>>(() => new Set(initial));
  const toggle = useCallback((item: T) => {
    setState((prev) => {
      const next = new Set(prev);
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return next;
    });
  }, []);
  return [state, toggle, setState];
}
