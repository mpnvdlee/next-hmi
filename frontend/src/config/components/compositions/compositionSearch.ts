import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { WidgetConfig } from '@shared/types/config';
import { matchesSearchWords, withDotSearchSeparators } from '@shared/utils/search';
import { filterComponents } from '../editor/WidgetTree/treeFilters';

interface CompositionSearchResult {
  widgets: ComponentDefinition[];
  folders: string[];
}

/** A folder path as the search reads it: "A/B" is the path "A / B". */
function folderSearchPath(path: string): string {
  return path.split('/').join(' / ');
}

/** Every ancestor of a folder path, outermost first: "A/B/C" → ["A", "A/B"]. */
function ancestorPaths(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

/**
 * Filter the component list and the folder list against a tree search.
 *
 * A component survives on its own name, on its folder path, or because a widget
 * inside it matched — in which case only the matching branch of its tree is
 * kept, the same rule the page tree's filter follows.
 */
export function filterCompositions(
  widgets: ComponentDefinition[],
  folders: string[],
  query: string,
): CompositionSearchResult {
  if (!query.trim()) return { widgets, folders };
  const wordQuery = withDotSearchSeparators(query);

  // A folder matched by name shows everything under it, so its subtree is kept
  // whole rather than filtered again per component.
  const matchedFolders = folders.filter((path) =>
    matchesSearchWords(wordQuery, folderSearchPath(path)),
  );
  const insideMatchedFolder = (path: string | null | undefined) =>
    !!path && matchedFolders.some((folder) => path === folder || path.startsWith(`${folder}/`));

  const keptWidgets: ComponentDefinition[] = [];
  for (const widget of widgets) {
    const path = widget.group ? `${folderSearchPath(widget.group)} / ${widget.name}` : widget.name;
    if (insideMatchedFolder(widget.group) || matchesSearchWords(wordQuery, [path, widget.id])) {
      keptWidgets.push(widget);
      continue;
    }
    const children = filterComponents(widget.children as WidgetConfig[], wordQuery, path);
    if (children.length > 0) keptWidgets.push({ ...widget, children });
  }

  // A folder survives as a match, as the home of a surviving component, or as an
  // ancestor of either — the tree can only nest a folder whose parents are there.
  const kept = new Set<string>();
  const keep = (path: string) => {
    kept.add(path);
    for (const ancestor of ancestorPaths(path)) kept.add(ancestor);
  };
  for (const folder of folders) if (insideMatchedFolder(folder)) keep(folder);
  for (const widget of keptWidgets) if (widget.group) keep(widget.group);

  return { widgets: keptWidgets, folders: folders.filter((folder) => kept.has(folder)) };
}
