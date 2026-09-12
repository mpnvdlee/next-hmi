import { useState } from 'react';
import { withBase } from '@shared/utils/runtimeBase';

interface Props {
  id: string;
  name: string;
  updatedAt: string | null;
}

export default function ProjectThumbnail({ id, name, updatedAt }: Props) {
  // Tracks the updatedAt value a load failed for, rather than a plain
  // boolean, so a later re-save (a fresh updatedAt) gets a clean retry
  // instead of being stuck behind a stale failure.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  if (!updatedAt || failedFor === updatedAt) {
    return (
      <div className="project-thumb project-thumb--empty" aria-hidden="true">
        <span className="project-thumb__initial">{name.trim().charAt(0).toUpperCase()}</span>
      </div>
    );
  }
  const src = `${withBase(`/api/projects/${id}/thumbnail`)}?v=${encodeURIComponent(updatedAt)}`;
  return (
    <img
      className="project-thumb"
      src={src}
      alt={`${name} main page`}
      onError={() => setFailedFor(updatedAt)}
    />
  );
}
