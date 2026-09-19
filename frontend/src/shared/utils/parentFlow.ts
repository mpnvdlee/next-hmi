/**
 * Which widget types arrange their own children with flexbox. The one thing
 * left of the pre-fase-3 flow-resolution system: whether a container-mode
 * widget shows the Direction/Align/Justify panel rows at all still needs to
 * know this — everything else about *which* axis is main now lives entirely
 * in `hmi.css`'s flow-translation block, read off a flex parent's own
 * `data-flow-direction`/`data-flow-align` (`containerLayoutProps` in
 * `hmi/components/layoutUtils.ts`), not resolved ahead of time here.
 */
import builtinWidgetsManifest from '../../generated/builtinWidgetsManifest.json';

/**
 * Types that declared `flowsChildren` on their manifest row. Seeded from the
 * built-in manifest at module eval so the answer is there before any registry
 * loads, and rewritten per type by {@link setFlowsChildren} as a project's own
 * widgets register on top.
 */
const flowTypes = new Set(
  (builtinWidgetsManifest as { name?: string; flowsChildren?: boolean | null }[])
    .filter((entry) => entry.flowsChildren === true)
    .map((entry) => String(entry.name)),
);

/** Record one type's `flowsChildren` declaration. Called by `widgetRegistry` on
 *  every registration — a project widget shadowing a built-in must report *its*
 *  answer, and a recompile may take the declaration away again. */
export function setFlowsChildren(type: string, flows: boolean): void {
  if (flows) flowTypes.add(type);
  else flowTypes.delete(type);
}

/**
 * Whether a widget of this type arranges its own children with flexbox — the one
 * thing that makes a node a resolvable parent flow.
 *
 * Declared, not hardcoded: `containerLayoutProps` is on the custom-widget SDK,
 * so a project can ship its own flex container and its children must get the
 * same axis, the same panel rows and the same migration treatment the built-in
 * `Container`'s do. Narrower than `hostsChildren` — an `ImageContainer` hosts
 * children but pins them to image slots, a `$component:` instance arranges
 * them inside its own definition, and a leaf has none.
 */
export function usesFlexLayout(type: string): boolean {
  return flowTypes.has(type);
}
