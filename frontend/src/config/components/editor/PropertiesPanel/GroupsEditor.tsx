import { useEffect, useMemo } from 'react';
import { useUsersDomainStore } from '@config/store/domains/usersDomainStore';
import type { UserGroup } from '@config/store/domains/usersDomainStore';
import { Kw, PreviewText } from '../PropertySourceEditor/editors/shared';

const EMPTY_GROUPS: UserGroup[] = [];

/** Collapsed one-line summary for a `groups` checklist value — same colored-keyword
 *  shape as the `$userGroups` source preview (see `propertyValueUtils`/`shared.tsx`). */
export function GroupsSummary({
  value,
  options,
  emptyLabel = 'everyone',
}: {
  value: unknown;
  /** Groups to label against. Omit to read the users document (the editor case). */
  options?: UserGroup[];
  /** What an empty selection means for this field. */
  emptyLabel?: string;
}) {
  const stored = useUsersDomainStore((s) => s.draft?.groups ?? s.data?.groups ?? EMPTY_GROUPS);
  const ensureLoaded = useUsersDomainStore((s) => s.ensureLoaded);
  const external = options !== undefined;
  useEffect(() => {
    if (!external) ensureLoaded();
  }, [ensureLoaded, external]);
  const groups = options ?? stored;
  const labels = useMemo(() => Object.fromEntries(groups.map((g) => [g.id, g.label])), [groups]);
  const selected = Array.isArray(value) ? (value as string[]) : [];
  return (
    <PreviewText>
      {selected.length === 0 ? (
        <Kw tint="userGroups">{emptyLabel}</Kw>
      ) : (
        <>
          <Kw tint="userGroups">groups: </Kw>
          {selected.map((id) => labels[id] ?? id).join(', ')}
        </>
      )}
    </PreviewText>
  );
}

export default function GroupsEditor({
  value,
  onChange,
  options,
  requireOne,
  showIds,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  /** Groups to offer. Omit to read the users document — the editor's own fields
   *  do, but the users page already holds the (possibly unsaved) draft list. */
  options?: UserGroup[];
  /** Keeps the last checked box checked. For memberships where "no group" is not
   *  a meaningful state, unlike a permission list where empty means everyone. */
  requireOne?: boolean;
  /** Show each group's id beside its label — the users page identifies groups by
   *  id, so the label alone is ambiguous while ids are being authored. */
  showIds?: boolean;
}) {
  const stored = useUsersDomainStore((s) => s.draft?.groups ?? s.data?.groups ?? EMPTY_GROUPS);
  const ensureLoaded = useUsersDomainStore((s) => s.ensureLoaded);
  const external = options !== undefined;

  useEffect(() => {
    if (!external) ensureLoaded();
  }, [ensureLoaded, external]);
  const groups = options ?? stored;
  const selected = Array.isArray(value) ? (value as string[]) : [];

  function toggle(id: string) {
    if (selected.includes(id)) {
      if (requireOne && selected.length <= 1) return;
      const next = selected.filter((g) => g !== id);
      onChange(!requireOne && next.length === 0 ? undefined : next);
      return;
    }
    onChange([...selected, id]);
  }

  if (groups.length === 0) {
    return <span className="cfg-prop-hint">(no groups defined)</span>;
  }

  return (
    <div className="cfg-groups-checkboxes">
      {groups.map((g) => (
        <label key={g.id} className="cfg-groups-checkbox">
          <input type="checkbox" checked={selected.includes(g.id)} onChange={() => toggle(g.id)} />
          {g.label}
          {showIds && <span className="cfg-groups-checkbox__id">{g.id}</span>}
        </label>
      ))}
    </div>
  );
}
