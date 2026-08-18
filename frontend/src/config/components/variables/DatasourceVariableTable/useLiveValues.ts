import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useVariableStore } from '@hmi/store/variableStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { buildVarKey } from '@shared/types/datasource';
import type { RowItem } from '@config/components/ui/datasourceTreeHelpers';
import type { VirtualizerIndexLike } from './virtualizerTypes';

interface Params {
  showLive: boolean;
  dsName: string;
  rows: RowItem[];
  virtualizer: VirtualizerIndexLike;
  scrollRef: RefObject<HTMLDivElement | null>;
}

function sendPriorityContext(priorityKeys: string[]) {
  sendWsMessage({
    type: 'set_context',
    currentPageIds: [],
    openDialogIds: [],
    priorityKeys,
  });
}

function sameValues(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export function useLiveValues({ showLive, dsName, rows, virtualizer, scrollRef }: Params) {
  const [liveValues, setLiveValues] = useState<Record<string, string>>({});

  const liveValuesRef = useRef(liveValues);
  liveValuesRef.current = liveValues;

  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const dsNameRef = useRef(dsName);
  dsNameRef.current = dsName;

  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  const readVisibleRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!showLive) {
      setLiveValues({});
      sendPriorityContext([]);
      return;
    }

    const readVisible = () => {
      const { values, varMeta, snapshotReceived } = useVariableStore.getState();
      if (!snapshotReceived) return;

      const vItems = virtualizerRef.current.getVirtualItems();
      const next: Record<string, string> = {};

      for (const vi of vItems) {
        const row = rowsRef.current[vi.index];
        if (row?.kind !== 'variable') continue;

        const key = buildVarKey(dsNameRef.current, row.path);
        if (!(key in values)) continue;
        const isStruct = varMeta[key]?.type.kind === 'struct';
        next[key] = isStruct ? '{…}' : String(values[key]);
      }

      if (sameValues(next, liveValuesRef.current)) return;
      liveValuesRef.current = next;
      setLiveValues(next);
    };

    readVisibleRef.current = readVisible;
    readVisible();

    let rafId: number | null = null;
    const scheduleRead = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        readVisible();
        rafId = null;
      });
    };

    // Manual slice diff (rather than a plain whole-store subscribe) so unrelated
    // store ticks — a different datasource's variables, wsConnected, etc. — never
    // schedule a readVisible() pass. Zustand's selector-based subscribe would need
    // the subscribeWithSelector middleware, which the store doesn't use.
    const unsub = useVariableStore.subscribe((state, prevState) => {
      if (state.snapshotReceived !== prevState.snapshotReceived) {
        scheduleRead();
        return;
      }
      if (!state.snapshotReceived) return;

      const vItems = virtualizerRef.current.getVirtualItems();
      for (const vi of vItems) {
        const row = rowsRef.current[vi.index];
        if (row?.kind !== 'variable') continue;

        const key = buildVarKey(dsNameRef.current, row.path);
        if (
          state.values[key] !== prevState.values[key] ||
          state.varMeta[key] !== prevState.varMeta[key]
        ) {
          scheduleRead();
          return;
        }
      }
    });

    return () => {
      readVisibleRef.current = null;
      unsub();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [showLive]);

  useEffect(() => {
    if (!showLive) return;

    const el = scrollRef.current;
    if (!el) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const handleScroll = () => {
      readVisibleRef.current?.();

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const vItems = virtualizerRef.current.getVirtualItems();
        const keys: string[] = [];
        const seen = new Set<string>();
        for (const vi of vItems) {
          const row = rowsRef.current[vi.index];
          const kind = row?.kind;
          if (kind === 'variable' || kind === 'array-element') {
            const key = buildVarKey(dsNameRef.current, row.path);
            if (!seen.has(key)) {
              seen.add(key);
              keys.push(key);
            }
          }
        }
        sendPriorityContext(keys);
      }, 30);
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    return () => {
      el.removeEventListener('scroll', handleScroll);
      if (timer) clearTimeout(timer);
      sendPriorityContext([]);
    };
  }, [showLive, scrollRef]);

  return liveValues;
}
