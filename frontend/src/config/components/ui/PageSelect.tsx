import type { ReactNode } from 'react';
import { getStaticString } from '@config/components/editor/propertyValueUtils';
import { useConfigStore } from '@shared/store/configStore';
import { flattenPages, isPageGroup, resolvePageTitle } from '@shared/utils/pageTree';
import type { PageNode } from '@shared/types/config';
import Select from './Select';

interface Props {
  value: unknown;
  onChange: (v: string | undefined) => void;
  /** Label of the empty option — what a blank value means for this field. */
  emptyLabel?: string;
}

/** `<option>` / `<optgroup>` list for the whole page tree, groups as optgroups. */
function renderPageOptions(nodes: PageNode[]): ReactNode[] {
  const out: ReactNode[] = [];
  for (const node of nodes) {
    if (isPageGroup(node)) {
      const descendants = flattenPages([node]);
      if (descendants.length === 0) continue;
      out.push(
        <optgroup key={node.id} label={resolvePageTitle(node.title)}>
          {descendants.map((p) => (
            <option key={p.id} value={p.id}>
              {resolvePageTitle(p.title)}
            </option>
          ))}
        </optgroup>,
      );
    } else {
      out.push(
        <option key={node.id} value={node.id}>
          {resolvePageTitle(node.title)}
        </option>,
      );
      const nestedDescendants = flattenPages([node]).filter((p) => p.id !== node.id);
      if (nestedDescendants.length > 0) {
        out.push(
          <optgroup key={`${node.id}__nested`} label={`${resolvePageTitle(node.title)} →`}>
            {nestedDescendants.map((p) => (
              <option key={p.id} value={p.id}>
                {resolvePageTitle(p.title)}
              </option>
            ))}
          </optgroup>,
        );
      }
    }
  }
  return out;
}

/**
 * Page picker over the project's page tree. Any field that stores a page id
 * uses this instead of a free-text input; an id that no longer resolves stays
 * selectable so it is visible rather than silently dropped.
 */
export default function PageSelect({ value, onChange, emptyLabel = '(none)' }: Props) {
  const pages = useConfigStore((s) => s.pages);
  const current = getStaticString(value);
  const known = new Set(flattenPages(pages).map((p) => p.id));

  return (
    <Select value={current} onChange={(v) => onChange(v || undefined)}>
      <option value="">{emptyLabel}</option>
      {renderPageOptions(pages)}
      {current && !known.has(current) && <option value={current}>{current} (missing)</option>}
    </Select>
  );
}
