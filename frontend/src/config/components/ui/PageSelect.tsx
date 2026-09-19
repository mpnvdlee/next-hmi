import type { ReactNode } from 'react';
import { getStaticString } from '@config/components/editor/propertyValueUtils';
import { useConfigStore } from '@shared/store/configStore';
import {
  allPageRootNodes,
  findPageNodeById,
  flattenPages,
  isPageGroup,
  resolvePageTitle,
} from '@shared/utils/pageTree';
import type { PageNode } from '@shared/types/config';
import Select from './Select';

interface Props {
  value: unknown;
  onChange: (v: string | undefined) => void;
  /** Label of the empty option — what a blank value means for this field. */
  emptyLabel?: string;
  /** Which page-tree roots to offer. `navigable` (the default) lists the Pages
   *  root alone; `all` adds the Dialogs folder under its own heading. */
  include?: 'navigable' | 'all';
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
 *
 * `include` decides whether the Dialogs folder is on offer. A field that
 * *navigates* — a menu item, the breadcrumb's home page, `$pageIsActive` —
 * cannot reach it: nothing routes to a Dialogs-folder page, so naming one
 * authors a dead target. A field that only *reads* a page passes `all`.
 */
export default function PageSelect({
  value,
  onChange,
  emptyLabel = '(none)',
  include = 'navigable',
}: Props) {
  const pages = useConfigStore((s) => s.pages);
  const dialogs = useConfigStore((s) => s.dialogs);
  const current = getStaticString(value);
  const offersDialogs = include === 'all';
  const offered = offersDialogs ? allPageRootNodes({ pages, dialogs }) : pages;
  const known = new Set(flattenPages(offered).map((p) => p.id));
  // A value authored before the field stopped offering them stays listed and
  // named for what it is, so a dead target is visible rather than reading as a
  // deleted page or vanishing from the control that owns it.
  const strandedOverlay =
    !offersDialogs && current && !known.has(current)
      ? findPageNodeById(dialogs, current)
      : undefined;

  return (
    <Select value={current} onChange={(v) => onChange(v || undefined)}>
      <option value="">{emptyLabel}</option>
      {renderPageOptions(pages)}
      {offersDialogs && dialogs.length > 0 && (
        <optgroup label="Dialogs">{renderPageOptions(dialogs)}</optgroup>
      )}
      {strandedOverlay && (
        <option value={current}>
          {resolvePageTitle(strandedOverlay.title)} (overlay — not navigable)
        </option>
      )}
      {current && !known.has(current) && !strandedOverlay && (
        <option value={current}>{current} (missing)</option>
      )}
    </Select>
  );
}
