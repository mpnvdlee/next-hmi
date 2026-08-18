import { useEffect } from 'react';
import { useProjectStore } from '@shared/store/projectStore';
import { useUsersDomainStore } from '@config/store/domains/usersDomainStore';
import { useHmiStore } from '@hmi/store/hmiStore';

function raise(message: string) {
  useHmiStore.getState().showToast({
    id: crypto.randomUUID(),
    message,
    // `manual` — a failed save leaves the project dirty and nothing else on
    // screen says why, so the reason must survive until it has been read.
    severity: 'error',
    discard: 'manual',
    duration: 0,
  });
}

/** Reports a failed save, and what caused it, through the editor toast stack. */
export function useSaveErrorToast() {
  const saveError = useProjectStore((s) => s.saveError);
  const dismissSaveError = useProjectStore((s) => s.dismissSaveError);
  const usersSaveError = useUsersDomainStore((s) => s.saveError);

  useEffect(() => {
    if (!saveError) return;
    raise(`Nothing was saved — ${saveError}. Your changes are still here; fix and save again.`);
    // The toast now owns the message, so the store flag resets and a repeated
    // failure with the same reason still raises a fresh toast.
    dismissSaveError();
  }, [saveError, dismissSaveError]);

  useEffect(() => {
    if (!usersSaveError) return;
    raise(
      `Security settings were not saved — ${usersSaveError}. Your changes are still here; fix and save again.`,
    );
  }, [usersSaveError]);
}
