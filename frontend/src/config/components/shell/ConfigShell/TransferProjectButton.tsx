import { useEffect, useState } from 'react';
import Button from '@config/components/ui/Button';
import PeerTransferModal from '@config/components/projects/ProjectsView/PeerTransferModal';
import { useUsersDomainStore } from '@config/store/domains/usersDomainStore';
import { useProjectStore } from '@shared/store/projectStore';
import { managerApiJson } from '@shared/utils/api';
import { getArea, projectSlug } from '@shared/utils/runtimeBase';

interface ProjectsResponse {
  projects?: Array<{ id: string; name: string }>;
}

/**
 * Push the open project to a peer, without a detour through the dashboard.
 *
 * Transfers are manager-to-manager, so this only exists where a manager is
 * serving the editor — never on a bare instance or the dev server. The
 * archive is built from the project on disk, so unsaved edits would be
 * silently left behind; the button stays disabled until they are saved.
 */
export default function TransferProjectButton() {
  const id = getArea() === 'editor' ? projectSlug() : null;
  const [name, setName] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const dirty = useProjectStore((s) => s.dirty);
  const saving = useProjectStore((s) => s.saving);
  const usersDirty = useUsersDomainStore((s) => s.dirty);
  const usersSaving = useUsersDomainStore((s) => s.saving);

  useEffect(() => {
    if (!id) return;
    let active = true;
    managerApiJson<ProjectsResponse>('/api/projects')
      .then((r) => {
        if (active) setName(r.projects?.find((p) => p.id === id)?.name ?? null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [id]);

  if (!id) return null;

  const unsaved = dirty || usersDirty;
  return (
    <>
      <Button
        variant="ghost"
        disabled={unsaved || saving || usersSaving}
        title={
          unsaved
            ? 'Save your changes before transferring'
            : 'Send this project to another NEXT HMI device'
        }
        onClick={() => setOpen(true)}
      >
        Transfer
      </Button>
      {open && (
        <PeerTransferModal
          direction="push"
          source={{ id, name: name ?? id }}
          onClose={() => setOpen(false)}
          onTransferred={() => setOpen(false)}
        />
      )}
    </>
  );
}
