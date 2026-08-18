import { useSyncExternalStore } from 'react';
import { useHttpSourceStore } from '../store/httpSourceStore';

/**
 * Re-render the calling widget when an `$http` response lands, but only when
 * `active` is true (pass `usesHttp(...)`). Inactive callers subscribe to
 * nothing, so a page full of ordinary widgets never re-renders on someone
 * else's API poll.
 *
 * Unlike `useLiveScalars` this is deliberately coarse — every `$http` widget
 * wakes on any cached response changing. The request key depends on the
 * *resolved* url, which only the evaluator knows, so there is no key list to
 * subscribe to at this boundary; `$http` sources are rare enough that the
 * shared wake-up costs less than threading eval results back out here.
 */
export function useHttpTick(active: boolean): void {
  useSyncExternalStore(
    active ? useHttpSourceStore.subscribe : noopSubscribe,
    active ? getEntries : getEmpty,
    active ? getEntries : getEmpty,
  );
}

const EMPTY = {};
const getEntries = () => useHttpSourceStore.getState().entries;
const getEmpty = () => EMPTY;
const noopSubscribe = () => () => {};
