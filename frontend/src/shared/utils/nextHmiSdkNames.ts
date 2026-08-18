/**
 * Single source of truth for the names exposed on `window.__nextHMI__` for
 * custom components.
 *
 * Used by:
 *  - `nextHmiSdk.ts` — builds the object and warns at boot if any name here is
 *    missing from it (catches runtime/contract drift loudly at app boot).
 *  - `backend/services/widget_compiler.py` — the backend compiler scans each
 *    component's JS output and emits a minimal
 *    `const { … } = window.__nextHMI__;` banner containing only the names
 *    that component actually references.
 *
 * Adding a new SDK function: add the name here, add the runtime assignment in
 * `frontend/src/nextHmiSdk.ts`, and add the type declaration in
 * `frontend/custom-widgets-sdk.d.ts`. The per-component banner is generated
 * automatically.
 *
 * That third step is enforced by `nextHmiSdkNames.test.ts`, which also checks
 * the `.d.ts` interfaces mirroring app types field-for-field. It has to: the
 * `.d.ts` sits outside `tsconfig.json`'s `include` (its declarations are
 * globals and would collide with the real `useState` / `React` / …), so the
 * compiler never sees it and it drifts silently otherwise.
 */

/**
 * Versioned independently of the app (see docs/dev/reference/custom-widgets.md's
 * "Runtime SDK" section). Bump on any removed/renamed name or incompatible
 * signature/return-shape change; additive-only changes don't need a bump.
 */
export const SDK_VERSION = 1;

export const SDK_NAMES = [
  'React',
  'useState',
  'useEffect',
  'useMemo',
  'useCallback',
  'useRef',
  'createPortal',
  'useStructVariable',
  'useEvalContext',
  'sendWsMessage',
  'useHmiScope',
  'selfLayoutStyle',
  'containerLayoutStyle',
  'widgetColorStyle',
  'bindingKey',
  'parseVarKey',
  'getPropString',
  'getPropNumber',
  'getPropBoolean',
  'getPropBinding',
  'getPropBindingOrStatic',
  'usePropVar',
  'usePropString',
  'usePropNumber',
  'usePropBoolean',
  'usePropStruct',
  'useRecordListProp',
  'useCssVar',
  'useVariable',
  'useBindingValue',
  'useVariableMeta',
  'usePublishWidgetProp',
  'useUsersData',
  'useUserGroupsData',
  'useLanguagesData',
  'useLanguageSelection',
  'usePageGroup',
  'usePageTitle',
  'resolvePageTitle',
  'useNavigateToPage',
  'useVisiblePages',
  'useActiveAlarms',
  'useAlarmSummary',
  'useAlarmText',
  'useAlarmUsername',
  'alarmLevelClass',
  'levelDotClass',
  'formatAlarmTimeShort',
  'formatAlarmDateTime',
  'ackAlarm',
  'ackAllAlarms',
  'AlarmDetailDialog',
  'getBuiltinIconComponent',
  'isBuiltinIconId',
  'isCustomIconAssetPath',
  'useInlineSvg',
  'withBase',
  'apiJson',
  'isApiError',
  'executeWidgetActions',
  'useRecipeConfig',
  'useRecipeState',
  'recipeDownload',
  'recipeUpload',
  'Recharts',
  'VirtualKeyboard',
  'VirtualNumpad',
  'CloseButton',
  'useWriteVariable',
] as const;
