import type { ComponentType, ReactNode } from 'react';

/**
 * Edition seam — the open-source half.
 *
 * This is the `NEXTHMI_EDITION=oss` target of the `@enterprise` alias, and it
 * is deliberately empty: the public build ships no enterprise code at all. The
 * `ee` build points the same alias at the enterprise repository's registry,
 * which returns real components. Consumers spread these arrays unconditionally
 * and never test the edition, so an empty array tree-shakes the call site away.
 *
 * A build-time alias, not a runtime plugin loader — there is no discovery, no
 * manifest, and no SDK contract to keep stable.
 */

/** Sections appended to the manager Settings page. */
export const enterpriseSettingsPanels: ComponentType[] = [];

/** Sections appended to the config (instance) Admin page. */
export const enterpriseAdminSections: ComponentType[] = [];

/**
 * Wrappers the manager dashboard is rendered inside, after the device-admin
 * password gate. A wrapper may render something else entirely instead of its
 * children — the `ee` build uses one to hold the dashboard behind runtime
 * activation. Empty here, so the public build renders the dashboard directly.
 */
export const enterpriseAppGates: ComponentType<{ children: ReactNode }>[] = [];

/**
 * Run when the device admin signs out, so state added through this seam is
 * dropped with the session. Core clears its own stores directly and knows
 * nothing about what these callbacks close over.
 */
export const enterpriseSessionResets: Array<() => void> = [];
