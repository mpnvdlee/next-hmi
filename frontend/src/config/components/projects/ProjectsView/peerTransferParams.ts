import { randomUuid } from '@shared/utils/id';

export type CollisionPolicy = 'reject' | 'replace' | 'copy';

/** Every request parameter the backend fingerprints that this form can change. */
export interface TransferParams {
  sourceProjectId: string;
  destinationFolder: string;
  collisionPolicy: CollisionPolicy;
  replacementId: string;
  confirmReplace: boolean;
  start: boolean;
}

/** The first `<folder>`, `<folder>-2`, `<folder>-3`… no known project holds. */
export function freeFolderName(base: string, taken: ReadonlySet<string>): string {
  const trimmed = base.trim() || 'project';
  if (!taken.has(trimmed)) return trimmed;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${trimmed}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${trimmed}-${randomUuid().slice(0, 8)}`;
}

export function sameParams(a: TransferParams, b: TransferParams): boolean {
  return (
    a.sourceProjectId === b.sourceProjectId &&
    a.destinationFolder === b.destinationFolder &&
    a.collisionPolicy === b.collisionPolicy &&
    a.replacementId === b.replacementId &&
    a.confirmReplace === b.confirmReplace &&
    a.start === b.start
  );
}
