import { create } from 'zustand';
import type {
  AnchorRect,
  ButtonAction,
  OverlayBackdrop,
  OverlaySize,
  OverlayPlacement,
} from '@shared/types/config';

/**
 * hmiStore — runtime state for the live HMI operator view.
 *
 * openPageOverlays: page overlays currently shown, in the order they opened,
 *   each with size/placement metadata and the input-parameter values supplied
 *   at openPageOverlay time, which descendants resolve through `$componentProp`
 *   lookups (pass-by-reference). Those belong to the overlay instance, so they
 *   survive navigating to a sibling page inside it (`updatePageOverlay` moves
 *   `activePageId`, never `pageId`).
 * currentUsersByScope: per-scope authenticated user identity (from user_identity WS messages).
 * loginErrorsByScope: per-scope last login error (from auth_error WS messages).
 */

export interface PageOverlayEntry {
  /** The node the action targeted — a page or a page group. This is the
   *  overlay's identity: it never moves, so `closePageOverlay` can still name
   *  the group an overlay was opened with after the operator changed tabs. */
  pageId: string;
  /** The page currently shown inside the overlay, once navigation moved off
   *  `pageId` (or resolved a targeted group to one of its children). */
  activePageId?: string;
  /** Pass-by-reference values for the overlay target's declared input parameters. */
  componentProperties: Record<string, unknown>;
  size: OverlaySize;
  placement: OverlayPlacement;
  width?: number;
  height?: number;
  /** Trigger bounds when placement is anchored (`trigger-*`). */
  anchorRect?: AnchorRect;
  backdrop?: OverlayBackdrop;
}

/**
 * Does this overlay answer to `id` — either as the node the action named
 * (`pageId`, its immutable identity) or as the page it currently shows
 * (`activePageId`, after in-overlay navigation)?
 *
 * Every id comparison against an open overlay goes through here. Opening,
 * collapsing and closing each used to test a different subset of the two
 * fields, which let a second card stack on a page another overlay had
 * navigated to, and let one `closePageOverlay` remove two overlays.
 */
function overlayMatches(entry: PageOverlayEntry, id: string): boolean {
  return entry.pageId === id || entry.activePageId === id;
}

interface UserIdentity {
  username: string;
  groups: string[];
  groupLabels: Record<string, string>;
}

export interface AlertEntry {
  id: string;
  title: string;
  description: string;
  cancelText: string;
  okText: string;
  dismissible: boolean;
  onCancel: ButtonAction[];
  onOk: ButtonAction[];
  /** Firing site's input scope, captured at showAlert time so onOk/onCancel
   *  can replay against the originating widget/overlay rather than the
   *  scope-less top of HmiView where AlertModal lives. */
  inputScopeProps?: Record<string, unknown>;
}

export interface ToastEntry {
  id: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  discard: 'auto' | 'manual';
  /** Auto-dismiss timeout in milliseconds (default 4000). */
  duration: number;
}

interface HmiStore {
  openPageOverlays: PageOverlayEntry[];
  pendingAlerts: AlertEntry[];
  pendingToasts: ToastEntry[];
  currentUsersByScope: Record<string, UserIdentity>;
  loginErrorsByScope: Record<string, string | null>;
  openPageOverlay: (entry: PageOverlayEntry) => void;
  /** Closes by the overlay's target id or by the page it currently shows. */
  closePageOverlay: (id?: string) => void;
  /** Moves the overlay identified by `overlayId` onto `nextPageId`. */
  updatePageOverlay: (overlayId: string, nextPageId: string) => void;
  showAlert: (entry: AlertEntry) => void;
  dismissAlert: (id: string) => void;
  showToast: (entry: ToastEntry) => void;
  dismissToast: (id: string) => void;
  setCurrentUser: (scope: string, user: UserIdentity | null) => void;
  setLoginError: (scope: string, error: string | null) => void;
}

export const useHmiStore = create<HmiStore>((set) => ({
  openPageOverlays: [],
  pendingAlerts: [],
  pendingToasts: [],
  currentUsersByScope: {},
  loginErrorsByScope: {},
  openPageOverlay: (entry) =>
    set((state) => {
      if (!entry.pageId || state.openPageOverlays.some((e) => overlayMatches(e, entry.pageId)))
        return state;
      return { openPageOverlays: [...state.openPageOverlays, entry] };
    }),
  closePageOverlay: (id) =>
    set((state) => {
      if (!id) {
        return state.openPageOverlays.length > 0
          ? { openPageOverlays: state.openPageOverlays.slice(0, -1) }
          : state;
      }
      // Topmost match only. `openPageOverlay` refuses a duplicate, so at most
      // one entry should ever match — but matching on two fields means a filter
      // would close both if that invariant ever slipped, and closing an overlay
      // the operator did not name is worse than leaving one open.
      let index = -1;
      for (let i = state.openPageOverlays.length - 1; i >= 0; i--) {
        if (overlayMatches(state.openPageOverlays[i], id)) {
          index = i;
          break;
        }
      }
      if (index === -1) return state;
      return {
        openPageOverlays: state.openPageOverlays.filter((_, i) => i !== index),
      };
    }),
  updatePageOverlay: (overlayId, nextPageId) =>
    set((state) => {
      if (!overlayId || !nextPageId) return state;
      const current = state.openPageOverlays.find((e) => e.pageId === overlayId);
      if (!current) return state;
      if (current.activePageId === nextPageId) return state;
      // Navigating onto a page some *other* overlay already shows collapses the
      // two rather than stacking the same page twice. The entry being moved is
      // excluded: its own target id is not a collision with itself, which is
      // what navigating back to the page an overlay was opened with looks like.
      if (state.openPageOverlays.some((e) => e !== current && overlayMatches(e, nextPageId))) {
        return {
          openPageOverlays: state.openPageOverlays.filter((e) => e !== current),
        };
      }
      return {
        openPageOverlays: state.openPageOverlays.map((e) =>
          e === current ? { ...e, activePageId: nextPageId } : e,
        ),
      };
    }),
  showAlert: (entry) => set((state) => ({ pendingAlerts: [...state.pendingAlerts, entry] })),
  dismissAlert: (id) =>
    set((state) => ({
      pendingAlerts: state.pendingAlerts.filter((a) => a.id !== id),
    })),
  showToast: (entry) => set((state) => ({ pendingToasts: [...state.pendingToasts, entry] })),
  dismissToast: (id) =>
    set((state) => ({
      pendingToasts: state.pendingToasts.filter((t) => t.id !== id),
    })),
  setCurrentUser: (scope, user) =>
    set((state) => {
      if (user === null) {
        const next = { ...state.currentUsersByScope };
        delete next[scope];
        return { currentUsersByScope: next };
      }
      return { currentUsersByScope: { ...state.currentUsersByScope, [scope]: user } };
    }),
  setLoginError: (scope, error) =>
    set((state) => ({
      loginErrorsByScope: { ...state.loginErrorsByScope, [scope]: error },
    })),
}));
