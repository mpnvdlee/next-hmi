import { useHmiStore } from '@hmi/store/hmiStore';
import { takeSlugId } from '@shared/utils/id';
import { deepCloneComponent } from '@shared/store/configStoreHelpers';
import { CONTENT_SECTION_ID } from '@shared/utils/pageContent';
import type {
  WidgetConfig,
  PageConfig,
  PageGroupConfig,
  PageGroupChild,
  DialogConfig,
} from '@shared/types/config';
export type ClipboardNodeKind = 'widget' | 'page' | 'page-group' | 'dialog';

export type ClipboardNode =
  | { kind: 'widget'; node: WidgetConfig }
  | { kind: 'page'; node: PageConfig }
  | { kind: 'page-group'; node: PageGroupConfig }
  | { kind: 'dialog'; node: DialogConfig };

/** Several nodes copied at once. A single node still writes its bare JSON, so the
 *  common case stays readable and interchangeable with older builds. */
export interface ClipboardMulti {
  kind: 'multi';
  nodes: ClipboardNode[];
}

export type ClipboardEntry = ClipboardNode | ClipboardMulti;

/** Envelope marker for a multi-node payload. An older build's `classify` falls
 *  through every branch on this shape and reports "not a copyable tree node",
 *  which is a clean refusal rather than a mis-paste. */
const MULTI_ENVELOPE = '$hmiClipboard';
const MULTI_VERSION = 1;

function toast(severity: 'info' | 'error', message: string): void {
  useHmiStore.getState().showToast({
    id: crypto.randomUUID(),
    message,
    severity,
    discard: 'auto',
    duration: 2500,
  });
}

const KIND_LABEL: Record<ClipboardNodeKind, string> = {
  widget: 'component',
  page: 'page',
  'page-group': 'page group',
  dialog: 'dialog',
};

function describe(entry: ClipboardEntry): string {
  return entry.kind === 'multi'
    ? `${entry.nodes.length} ${KIND_LABEL[entry.nodes[0]?.kind ?? 'widget']}s`
    : KIND_LABEL[entry.kind];
}

/** A cut writes the same JSON as a copy — only the wording and the pending-cut
 *  bookkeeping (see cutState) differ. */
export async function copyTreeNode(
  entry: ClipboardEntry,
  mode: 'copy' | 'cut' = 'copy',
): Promise<void> {
  // The envelope holds the same bare node shapes a single copy writes, so one
  // `classify` still decides what each of them is.
  const json = JSON.stringify(
    entry.kind === 'multi'
      ? { [MULTI_ENVELOPE]: MULTI_VERSION, nodes: entry.nodes.map((n) => n.node) }
      : entry.node,
  );
  try {
    await navigator.clipboard.writeText(json);
    toast('info', `${mode === 'cut' ? 'Cut' : 'Copied'} ${describe(entry)}`);
  } catch {
    toast('error', 'Clipboard write blocked');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classify(parsed: unknown): ClipboardNodeKind | null {
  if (!isRecord(parsed)) return null;
  if (typeof parsed.title === 'string' && Array.isArray(parsed.widgets)) return 'dialog';
  if (parsed.type === 'page-group' && Array.isArray(parsed.children)) return 'page-group';
  if (isRecord(parsed.sections)) return 'page';
  if (
    typeof parsed.type === 'string' &&
    typeof parsed.name === 'string' &&
    !('sections' in parsed) &&
    !('widgets' in parsed)
  ) {
    return 'widget';
  }
  return null;
}

/** The nodes of a `$hmiClipboard` envelope, or null when this is not one — or
 *  when its nodes are not all of one kind. Every consumer reads the batch's kind
 *  off the first node, so a foreign payload mixing kinds would be pasted, and
 *  refused, under the wrong node's rules.
 *
 *  Exported as the one reader of the envelope `copyTreeNode` writes: the
 *  components editor classifies the same clipboard, and a second parser there
 *  would silently stop recognising batches the day the marker or the version
 *  changes here. */
export function readMultiEnvelope(parsed: unknown): ClipboardNode[] | null {
  if (!isRecord(parsed) || parsed[MULTI_ENVELOPE] !== MULTI_VERSION) return null;
  if (!Array.isArray(parsed.nodes)) return null;
  const nodes: ClipboardNode[] = [];
  for (const raw of parsed.nodes) {
    const kind = classify(raw);
    if (!kind) return null;
    if (nodes.length > 0 && kind !== nodes[0].kind) return null;
    nodes.push({ kind, node: raw } as ClipboardNode);
  }
  return nodes.length > 0 ? nodes : null;
}

export async function readTreeNodeFromClipboard(): Promise<ClipboardEntry | null> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    toast('error', 'Clipboard read blocked');
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    toast('error', 'Clipboard is not valid JSON');
    return null;
  }
  const multi = readMultiEnvelope(parsed);
  if (multi) return { kind: 'multi', nodes: multi };
  const kind = classify(parsed);
  if (!kind) {
    toast('error', 'Clipboard is not a copyable tree node');
    return null;
  }
  return { kind, node: parsed } as ClipboardNode;
}

function regenSectionWidgets(widgets: unknown, taken: Set<string>): WidgetConfig[] {
  if (!Array.isArray(widgets)) return [];
  return widgets
    .filter(isRecord)
    .map((w) => deepCloneComponent(w as unknown as WidgetConfig, taken));
}

function regenPage(page: PageConfig, taken: Set<string>): PageConfig {
  const id = takeSlugId(typeof page.title === 'string' ? page.title : 'page', taken);
  const sectionsIn = page.sections ?? {};
  const sectionsOut: Record<string, WidgetConfig[]> = {};
  for (const [sectionId, widgets] of Object.entries(sectionsIn)) {
    sectionsOut[sectionId] = regenSectionWidgets(widgets, taken);
  }
  if (Object.keys(sectionsOut).length === 0) sectionsOut[CONTENT_SECTION_ID] = [];
  return {
    ...page,
    id,
    type: 'page',
    sections: sectionsOut,
  };
}

function regenPageGroupChild(child: PageGroupChild, taken: Set<string>): PageGroupChild {
  return isRecord(child) && (child as { type?: unknown }).type === 'page-group'
    ? regenPageGroup(child as PageGroupConfig, taken)
    : regenPage(child as PageConfig, taken);
}

function regenPageGroup(group: PageGroupConfig, taken: Set<string>): PageGroupConfig {
  const id = takeSlugId(typeof group.title === 'string' ? group.title : 'page-group', taken);
  return {
    ...group,
    id,
    type: 'page-group',
    children: Array.isArray(group.children)
      ? group.children.map((c) => regenPageGroupChild(c, taken))
      : [],
    header: Array.isArray(group.header)
      ? group.header.map((w) => deepCloneComponent(w, taken))
      : group.header,
    footer: Array.isArray(group.footer)
      ? group.footer.map((w) => deepCloneComponent(w, taken))
      : group.footer,
  };
}

function regenDialog(dialog: DialogConfig, taken: Set<string>): DialogConfig {
  const id = takeSlugId(dialog.title || 'dialog', taken);
  return {
    ...dialog,
    id,
    widgets: Array.isArray(dialog.widgets)
      ? dialog.widgets.map((w) => deepCloneComponent(w, taken))
      : [],
  };
}

export function regenerateIds(entry: ClipboardEntry, taken: Set<string>): ClipboardEntry {
  switch (entry.kind) {
    // One shared `taken` across the batch, or two clones can be handed the same id.
    case 'multi':
      return {
        kind: 'multi',
        nodes: entry.nodes.map((n) => regenerateIds(n, taken) as ClipboardNode),
      };
    case 'widget':
      return { kind: 'widget', node: deepCloneComponent(entry.node, taken) };
    case 'page':
      return { kind: 'page', node: regenPage(entry.node, taken) };
    case 'page-group':
      return { kind: 'page-group', node: regenPageGroup(entry.node, taken) };
    case 'dialog':
      return { kind: 'dialog', node: regenDialog(entry.node, taken) };
  }
}

export function pasteToast(severity: 'info' | 'error', message: string): void {
  toast(severity, message);
}
