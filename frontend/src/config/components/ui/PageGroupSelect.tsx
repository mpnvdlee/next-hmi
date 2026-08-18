import { useMemo } from 'react';
import { getStaticString } from '@config/components/editor/propertyValueUtils';
import { useConfigStore } from '@shared/store/configStore';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { resolvePageTitle } from '@shared/utils/pageTree';
import { findInPages } from '@shared/utils/widgetTree';
import type { PageGroupConfig } from '@shared/types/config';
import Select from './Select';

interface Props {
  value: unknown;
  onChange: (v: string | undefined) => void;
  placeholder?: string;
}

function groupLabel(group: PageGroupConfig | undefined): string {
  if (!group) return '';
  return resolvePageTitle(group.title) || group.id;
}

export default function PageGroupSelect({ value, onChange, placeholder }: Props) {
  const selectedId = useEditorDomainStore((s) => s.selectedId);
  const pages = useConfigStore((s) => s.pages);
  const chain = useMemo(
    () => (selectedId ? (findInPages(pages, selectedId).groupTrail ?? []) : []),
    [pages, selectedId],
  );
  const nearest = chain[chain.length - 1];
  const parent = chain[chain.length - 2];

  const current = getStaticString(value);

  const nearestLabel = nearest
    ? `${groupLabel(nearest)} (nearest)`
    : (placeholder ?? '(nearest ancestor)');
  const parentLabel = parent ? `${groupLabel(parent)} (parent)` : null;

  return (
    <Select value={current} onChange={(v) => onChange(v || undefined)}>
      <option value="">{nearestLabel}</option>
      {parentLabel && <option value="$parent">{parentLabel}</option>}
    </Select>
  );
}
