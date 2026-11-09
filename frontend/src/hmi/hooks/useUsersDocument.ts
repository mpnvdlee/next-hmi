import { useEffect, useSyncExternalStore } from 'react';
import { apiJson } from '@shared/utils/api';
import { subscribeConfigChanged } from '@shared/events/configChangedBus';

export interface UserEntry {
  id: string;
  username: string;
}

export interface UserGroupEntry {
  id: string;
  label: string;
}

interface UsersDocument {
  users: UserEntry[];
  groups: UserGroupEntry[];
}

const EMPTY_DOCUMENT: UsersDocument = { users: [], groups: [] };
let cachedDocument: UsersDocument | null = null;
let pendingLoad: Promise<UsersDocument> | null = null;
const listeners = new Set<() => void>();

function loadUsersDocument(): Promise<UsersDocument> {
  // `Promise.resolve(...)` rather than `.then(...)` straight off the call: this
  // runs from an effect with no error boundary above it, so a transport helper
  // that returns a non-promise would otherwise unmount the whole HMI tree
  // instead of degrading to "no users known yet".
  pendingLoad ??= Promise.resolve(
    apiJson<{ users?: UserEntry[]; groups?: UserGroupEntry[] }>('/api/users/roster'),
  )
    .then((document) => {
      cachedDocument = {
        users: Array.isArray(document?.users) ? document.users : [],
        groups: Array.isArray(document?.groups) ? document.groups : [],
      };
      listeners.forEach((listener) => listener());
      return cachedDocument;
    })
    .finally(() => {
      pendingLoad = null;
    });
  return pendingLoad;
}

// A users write anywhere refetches the roster once, for every reader at once.
subscribeConfigChanged((event) => {
  if (event.artifact_type === 'users' && cachedDocument) void loadUsersDocument().catch(() => {});
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => cachedDocument ?? EMPTY_DOCUMENT;

/** Share the session-cached `/api/users/roster` between the public SDK hooks. */
export function useUsersDocument(): UsersDocument {
  const document = useSyncExternalStore(subscribe, snapshot);

  useEffect(() => {
    if (!cachedDocument) void loadUsersDocument().catch(() => {});
  }, []);

  return document;
}
