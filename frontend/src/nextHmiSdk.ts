/**
 * The runtime SDK exposed on `window.__nextHMI__`.
 *
 * Pre-compiled widget modules — a project's custom widgets and the product
 * stdlib alike — read their React instance and every app helper off this
 * object rather than bundling their own copies.
 *
 * Split out of main.tsx so the stdlib test harness can install the same SDK the
 * app installs (widgets/testSdk.ts — deliberately not src/test-setup.ts;
 * see the comment there). Building a second copy for tests would add a fourth
 * place for the contract to drift, on top of nextHmiSdkNames.ts, this file and
 * custom-widgets-sdk.d.ts.
 *
 * Adding a name here is not enough: it also needs an entry in SDK_NAMES and a
 * declaration in custom-widgets-sdk.d.ts. `_assertSdkContract` below covers the
 * first at compile time, `nextHmiSdkNames.test.ts` the second.
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ensureRecharts } from '@shared/utils/rechartsLoader';

import { useStructVariable } from '@hmi/hooks/useStructVariable';
import { useEvalContext } from '@hmi/hooks/useEvalContext';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { useHmiScope } from '@hmi/context/HmiScopeContext';
import {
  selfLayoutStyle,
  containerLayoutStyle,
  widgetColorStyle,
  getPropString,
  getPropNumber,
  getPropBoolean,
  getPropBinding,
  getPropBindingOrStatic,
  usePropVar,
  usePropString,
  usePropNumber,
  usePropBoolean,
  usePropStruct,
  useRecordListProp,
  useCssVar,
} from '@hmi/components/layoutUtils';
import { useVariable, useBindingValue, useVariableMeta } from '@hmi/hooks/useVariable';
import { useWriteVariable } from '@hmi/hooks/useWriteVariable';
import { usePublishWidgetProp } from '@hmi/hooks/usePublishWidgetProp';
import { useUsersData } from '@hmi/hooks/useUsersData';
import { useUserGroupsData } from '@hmi/hooks/useUserGroupsData';
import { useLanguagesData } from '@hmi/hooks/useLanguagesData';
import {
  useRecipeConfig,
  useRecipeState,
  recipeDownload,
  recipeUpload,
} from '@hmi/hooks/useRecipeSdk';
import { useNavigateToPage } from '@hmi/hooks/useNavigateToPage';
import { useVisiblePages } from '@hmi/hooks/useVisiblePages';
import { useActiveAlarms } from '@hmi/hooks/useActiveAlarms';
import {
  getBuiltinIconComponent,
  isBuiltinIconId,
  isCustomIconAssetPath,
} from '@shared/utils/phosphorIcons';
import { useInlineSvg } from '@hmi/utils/useInlineSvg';
import { withBase } from '@shared/utils/runtimeBase';
import { apiJson, isApiError } from '@shared/utils/api';
import { useLanguageSelection } from '@hmi/hooks/useLanguageSelection';
import { useAlarmSummary } from '@hmi/hooks/useAlarmSummary';
import {
  useAlarmText,
  useAlarmUsername,
  alarmLevelClass,
  levelDotClass,
  formatAlarmTimeShort,
  formatAlarmDateTime,
  ackAlarm,
  ackAllAlarms,
} from '@hmi/components/alarmUtils';
import AlarmDetailDialog from '@hmi/components/AlarmDetailDialog';
import { usePageGroup } from '@hmi/components/PageGroupStackContext';
import { usePageTitle, resolvePageTitle } from '@shared/utils/pageTree';
import { executeWidgetActions } from '@hmi/utils/widgetActions';
import { bindingKey } from '@shared/types/config';
import { parseVarKey } from '@shared/types/datasource';
import { VirtualKeyboard } from '@shared/components/VirtualKeyboard';
import { VirtualNumpad } from '@shared/components/VirtualNumpad';
import CloseButton from '@shared/components/CloseButton';
import { SDK_NAMES } from '@shared/utils/nextHmiSdkNames';

export const nextHmiSdk = {
  React,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef: React.useRef,
  createPortal,
  useStructVariable,
  useEvalContext,
  sendWsMessage,
  useHmiScope,
  selfLayoutStyle,
  containerLayoutStyle,
  widgetColorStyle,
  bindingKey,
  parseVarKey,
  getPropString,
  getPropNumber,
  getPropBoolean,
  getPropBinding,
  getPropBindingOrStatic,
  usePropVar,
  usePropString,
  usePropNumber,
  usePropBoolean,
  usePropStruct,
  useRecordListProp,
  useCssVar,
  useVariable,
  useBindingValue,
  useVariableMeta,
  usePublishWidgetProp,
  useUsersData,
  useUserGroupsData,
  useLanguagesData,
  useLanguageSelection,
  usePageGroup,
  usePageTitle,
  resolvePageTitle,
  useNavigateToPage,
  useVisiblePages,
  useActiveAlarms,
  useAlarmSummary,
  useAlarmText,
  useAlarmUsername,
  alarmLevelClass,
  levelDotClass,
  formatAlarmTimeShort,
  formatAlarmDateTime,
  ackAlarm,
  ackAllAlarms,
  AlarmDetailDialog,
  getBuiltinIconComponent,
  isBuiltinIconId,
  isCustomIconAssetPath,
  useInlineSvg,
  withBase,
  apiJson,
  isApiError,
  executeWidgetActions,
  useRecipeConfig,
  useRecipeState,
  recipeDownload,
  recipeUpload,
  // Populated asynchronously by rechartsLoader's `ensureRecharts()` (empty in
  // manager mode, which never reads it) — see that file for why this isn't a
  // static import.
  Recharts: {} as typeof import('recharts'),
  VirtualKeyboard,
  VirtualNumpad,
  CloseButton,
  useWriteVariable,
};

declare global {
  interface Window {
    __nextHMI__: typeof nextHmiSdk;
  }
}

// Compile-time guard: nextHmiSdk and SDK_NAMES must agree on the same set of keys.
// If `tsc` complains about either of these failing the `extends never` constraint,
// the SDK contract has drifted — fix by adding the missing entry on the offending side.
type _SdkContract_MissingFromAssignment = Exclude<
  (typeof SDK_NAMES)[number],
  keyof typeof nextHmiSdk
>;
type _SdkContract_ExtraInAssignment = Exclude<keyof typeof nextHmiSdk, (typeof SDK_NAMES)[number]>;
function _assertSdkContract<_T extends never>(): void {}
_assertSdkContract<_SdkContract_MissingFromAssignment>();
_assertSdkContract<_SdkContract_ExtraInAssignment>();

/**
 * Publish the SDK on `window`.
 *
 * Called once at boot from main.tsx, and again from the test harness so a stdlib
 * widget source — which references these names as free identifiers, exactly as
 * its compiled form does — can be imported directly by a unit test.
 */
export function installNextHmiSdk(): void {
  window.__nextHMI__ = nextHmiSdk;

  // Runtime guard for cases where TS can't see the truth (e.g. `as` casts erasing
  // a missing field). Logs once at boot instead of waiting for a component to crash.
  for (const name of SDK_NAMES) {
    if (!(name in window.__nextHMI__)) {
      console.error(
        `[NEXTHMI] SDK contract drift: "${name}" is listed in nextHmiSdkNames but missing from window.__nextHMI__. Add the assignment in nextHmiSdk.ts.`,
      );
    }
  }
}

/**
 * Warm the SDK's `Recharts` slot. Separate from `installNextHmiSdk` and called
 * only from main.tsx: the loader fills the slot itself, and widgetRegistry
 * awaits it before importing a module that needs it, so this is a head start,
 * not a dependency — and keeping it off the install path spares every jsdom
 * test that installs the SDK from importing recharts + d3.
 */
export function warmRecharts(): void {
  void ensureRecharts();
}
