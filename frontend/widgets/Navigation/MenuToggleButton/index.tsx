/* @jsxRuntime classic */
export const schema = {
  bound: {
    type: 'boolean' as const,
    format: 'onoff' as const,
    label: 'Bound state',
    description: 'The state this button toggles — bind it to the same value the menu reads.',
    defaultValue: false,
  },
  iconCollapsed: { type: 'icon' as const, label: 'Icon (collapsed)', defaultValue: '☰' },
  iconExpanded: { type: 'icon' as const, label: 'Icon (expanded)', defaultValue: '×' },
  ariaLabel: {
    type: 'string' as const,
    label: 'Aria label',
    defaultValue: 'Toggle menu',
  },
  actions: { type: 'actions' as const, label: 'Actions' },
};

export const displayName = 'Menu Toggle';
export const description = 'Collapses or expands a bound menu state; swaps icon per state.';
export const category = 'Navigation';
export const icon = { type: 'builtin', name: 'list' } as const;

// `bound` must be a $var binding for the toggle to write back; non-$var
// expressions are read-only and require an `actions.onPress` for side effects.
export default function MenuToggleButton({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const scope = useHmiScope();
  const liveValue = usePropVar(properties, 'bound');
  const bound = Boolean(liveValue);
  const writeBound = useWriteVariable(properties, 'bound');

  const iconCollapsed = getPropString(properties, 'iconCollapsed', '☰', evalCtx);
  const iconExpanded = getPropString(properties, 'iconExpanded', '×', evalCtx);
  const ariaLabel = getPropString(properties, 'ariaLabel', 'Toggle menu', evalCtx);

  const iconName = bound ? iconExpanded : iconCollapsed;
  const IconComp = isBuiltinIconId(iconName) ? getBuiltinIconComponent(iconName) : null;
  const iconIsCustomAsset = isCustomIconAssetPath(iconName);
  const customSvg = useInlineSvg(iconIsCustomAsset ? iconName : null);

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    const actions = properties?.actions as ActionsConfig | undefined;
    executeWidgetActions(actions?.onPress, { scope, evalCtx, anchorEl: e.currentTarget });
    writeBound(!bound);
  }

  return (
    <button
      type="button"
      className="hmi-component hmi-menu-toggle"
      style={selfLayoutStyle(layout)}
      onClick={handleClick}
      aria-label={ariaLabel}
      aria-pressed={bound}
    >
      {IconComp ? (
        <React.Suspense fallback={null}>
          <IconComp size={20} weight="regular" />
        </React.Suspense>
      ) : iconIsCustomAsset && customSvg ? (
        <span className="hmi-menu-toggle__svg" dangerouslySetInnerHTML={{ __html: customSvg }} />
      ) : (
        <span className="hmi-menu-toggle__glyph">{iconName}</span>
      )}
    </button>
  );
}
