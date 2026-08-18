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
 * openDialogs: dialog entries currently shown as modal overlays. Each entry
 *   carries the component-property values supplied at openDialog time, which
 *   descendants resolve through `$componentProp` lookups (pass-by-reference).
 * openPageOverlays: page overlays currently shown, each with size/placement metadata.
 * currentUsersByScope: per-scope authenticated user identity (from user_identity WS messages).
 * loginErrorsByScope: per-scope last login error (from auth_error WS messages).
 */

export interface PageOverlayEntry {
  pageId: string;
  size: OverlaySize;
  placement: OverlayPlacement;
  width?: number;
  height?: number;
  /** Trigger bounds when placement is anchored (`trigger-*`). */
  anchorRect?: AnchorRect;
  backdrop?: OverlayBackdrop;
}

export interface DialogEntry {
  id: string;
  /** Pass-by-reference values for the dialog's declared component properties. */
  componentProperties: Record<string, unknown>;
  size?: OverlaySize;
  placement?: OverlayPlacement;
  width?: number;
  height?: number;
  /** Trigger bounds when placement is anchored (`trigger-*`). */
  anchorRect?: AnchorRect;
  backdrop?: OverlayBackdrop;
}

/** Extra positioning metadata for an opened dialog. */
interface DialogOpenOptions {
  size?: OverlaySize;
  placement?: OverlayPlacement;
  width?: number;
  height?: number;
  anchorRect?: AnchorRect;
  backdrop?: OverlayBackdrop;
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
   *  can replay against the originating widget/dialog rather than the
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
  openDialogs: DialogEntry[];
  openPageOverlays: PageOverlayEntry[];
  pendingAlerts: AlertEntry[];
  pendingToasts: ToastEntry[];
  currentUsersByScope: Record<string, UserIdentity>;
  loginErrorsByScope: Record<string, string | null>;
  openDialog: (
    id: string,
    componentProperties?: Record<string, unknown>,
    options?: DialogOpenOptions,
  ) => void;
  closeDialog: (id?: string) => void;
  openPageOverlay: (entry: PageOverlayEntry) => void;
  closePageOverlay: (id?: string) => void;
  updatePageOverlay: (currentId: string, nextId: string) => void;
  showAlert: (entry: AlertEntry) => void;
  dismissAlert: (id: string) => void;
  showToast: (entry: ToastEntry) => void;
  dismissToast: (id: string) => void;
  setCurrentUser: (scope: string, user: UserIdentity | null) => void;
  setLoginError: (scope: string, error: string | null) => void;
}

export const useHmiStore = create<HmiStore>((set) => ({
  openDialogs: [],
  openPageOverlays: [],
  pendingAlerts: [],
  pendingToasts: [],
  currentUsersByScope: {},
  loginErrorsByScope: {},
  openDialog: (id, componentProperties, options) =>
    set((state) => {
      if (!id || state.openDialogs.some((d) => d.id === id)) return state;
      return {
        openDialogs: [
          ...state.openDialogs,
          { id, componentProperties: componentProperties ?? {}, ...options },
        ],
      };
    }),
  closeDialog: (id) =>
    set((state) => {
      if (!id) {
        return state.openDialogs.length > 0
          ? { openDialogs: state.openDialogs.slice(0, -1) }
          : state;
      }
      return {
        openDialogs: state.openDialogs.filter((d) => d.id !== id),
      };
    }),
  openPageOverlay: (entry) =>
    set((state) => {
      if (!entry.pageId || state.openPageOverlays.some((e) => e.pageId === entry.pageId))
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
      return {
        openPageOverlays: state.openPageOverlays.filter((e) => e.pageId !== id),
      };
    }),
  updatePageOverlay: (currentId, nextId) =>
    set((state) => {
      if (!currentId || !nextId) return state;
      const current = state.openPageOverlays.find((e) => e.pageId === currentId);
      if (!current) return state;
      if (state.openPageOverlays.some((e) => e.pageId === nextId)) {
        return {
          openPageOverlays: state.openPageOverlays.filter((e) => e.pageId !== currentId),
        };
      }
      return {
        openPageOverlays: state.openPageOverlays.map((e) =>
          e.pageId === currentId ? { ...e, pageId: nextId } : e,
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
