import { useEffect, useState } from 'react';
import { apiJson } from '@shared/utils/api';

export interface UserEntry {
  id: number;
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

function loadUsersDocument(): Promise<UsersDocument> {
  if (cachedDocument) return Promise.resolve(cachedDocument);
  // `Promise.resolve(...)` rather than `.then(...)` straight off the call: this
  // runs from an effect with no error boundary above it, so a transport helper
  // that returns a non-promise would otherwise unmount the whole HMI tree
  // instead of degrading to "no users known yet".
  pendingLoad ??= Promise.resolve(
    apiJson<{ users?: UserEntry[]; groups?: UserGroupEntry[] }>('/api/users'),
  )
    .then((document) => {
      cachedDocument = {
        users: Array.isArray(document?.users) ? document.users : [],
        groups: Array.isArray(document?.groups) ? document.groups : [],
      };
      return cachedDocument;
    })
    .finally(() => {
      pendingLoad = null;
    });
  return pendingLoad;
}

/** Share the session-cached `/api/users` document between the public SDK hooks. */
export function useUsersDocument(): UsersDocument {
  const [document, setDocument] = useState(cachedDocument ?? EMPTY_DOCUMENT);

  useEffect(() => {
    if (cachedDocument) return;
    let cancelled = false;
    void loadUsersDocument().then(
      (loaded) => {
        if (!cancelled) setDocument(loaded);
      },
      () => {
        if (!cancelled) setDocument(EMPTY_DOCUMENT);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return document;
}
