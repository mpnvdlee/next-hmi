/* @jsxRuntime classic */
export const schema = {
  usernameText: {
    type: 'string' as const,
    label: 'Username text',
    group: 'Content',
    description: 'Overrides the signed-in username.',
  },
  groupsText: {
    type: 'string' as const,
    label: 'Groups text',
    group: 'Content',
    description: "Overrides the signed-in user's group list.",
  },
  signInLabel: {
    type: 'string' as const,
    label: 'Sign-in label',
    group: 'Content',
    defaultValue: 'Log in',
    description: 'Shown on the sign-in affordance while nobody is signed in.',
  },
  showGroups: {
    type: 'boolean' as const,
    format: 'onoff' as const,
    label: 'Show groups',
    group: 'Appearance',
    defaultValue: true,
  },
  signInIcon: {
    type: 'icon' as const,
    label: 'Sign-in icon',
    group: 'Appearance',
    description: 'Defaults to the lock glyph.',
  },
  signOutIcon: {
    type: 'icon' as const,
    label: 'Sign-out icon',
    group: 'Appearance',
    description: 'Defaults to the sign-out glyph.',
  },
  radius: {
    type: 'string' as const,
    format: 'length' as const,
    label: 'Radius',
    defaultToken: '--hmi-radius-full',
    group: 'Appearance',
  },
  actions: { type: 'actions' as const, label: 'On Press', group: 'Actions' },
  onSignIn: {
    type: 'actions' as const,
    label: 'On Sign In',
    group: 'Actions',
    event: 'onSignIn',
    description: 'Run by the sign-in affordance, which only appears once this is set.',
  },
  onSignOut: {
    type: 'actions' as const,
    label: 'On Sign Out',
    group: 'Actions',
    event: 'onSignOut',
    description: 'Run by the sign-out button, which only appears once this is set.',
  },
};

export const displayName = 'User Badge';
export const description =
  'Shows the signed-in user as an initialled badge, with optional sign-in and sign-out affordances.';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'user' } as const;

const GUEST = 'guest';
const SIGN_IN_ICON = 'lock';
const SIGN_OUT_ICON = 'sign-out';

/** "L. Vesterå" → "LV"; punctuation-only fragments ("L.") still yield a letter. */
function initialsOf(username: string): string {
  return (
    username
      .split(/[\s._-]+/)
      .map((part) => part.replace(/[^\p{L}\p{N}]/gu, '').charAt(0))
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}

function IconGlyph({ name }: { name: string }) {
  const Comp = isBuiltinIconId(name) ? getBuiltinIconComponent(name) : null;
  if (!Comp) return null;
  return (
    <React.Suspense fallback={null}>
      <Comp size={16} weight="bold" />
    </React.Suspense>
  );
}

export default function UserBadge({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const scope = useHmiScope();

  const pressActions = (properties?.actions as ActionsConfig | undefined)?.onPress;
  const signInActions = (properties?.onSignIn as ActionsConfig | undefined)?.onSignIn;
  const signOutActions = (properties?.onSignOut as ActionsConfig | undefined)?.onSignOut;
  const run = (actions: ComponentAction[] | undefined) =>
    executeWidgetActions(actions, { scope, evalCtx });

  const defaultUsername = evalCtx.resolveUser?.('username') ?? GUEST;
  const defaultGroups = evalCtx.resolveUser?.('groups') ?? GUEST;

  const usernameText = getPropString(properties, 'usernameText', defaultUsername, evalCtx);
  const groupsText = getPropString(properties, 'groupsText', defaultGroups, evalCtx);
  const signInLabel = getPropString(properties, 'signInLabel', 'Log in', evalCtx);
  const showGroups = getPropBoolean(properties, 'showGroups', true, evalCtx);
  const signInIcon = getPropString(properties, 'signInIcon', '', evalCtx) || SIGN_IN_ICON;
  const signOutIcon = getPropString(properties, 'signOutIcon', '', evalCtx) || SIGN_OUT_ICON;
  const radius = getPropString(properties, 'radius', '', evalCtx);
  // Icon-only, so its accessible name is the only text a screen reader gets.
  // Routed through the project's own translations rather than hard-coded, the
  // way the label the button replaced was.
  const signOutLabel = evalCtx.resolveTranslation?.('Log out') || 'Log out';

  // The radius rides a custom property rather than a literal inline
  // `borderRadius`: leaving it unset keeps the fully-round default in the
  // stylesheet, which an inline value would always beat.
  const style: Record<string, string | number> = { ...selfLayoutStyle(layout) };
  if (radius) style['--hmi-user-badge-radius'] = radius;

  // Guest is an identity the backend really signs in (`autoLoginName`), not the
  // absence of one — so the sign-in state is a name check, the same test the
  // rest of a project makes with `$user`. Checked against the real signed-in
  // user, not `usernameText`: that property is a cosmetic display override
  // (its own schema says so) and setting it must not be able to fake a
  // sign-in state.
  const isGuest = defaultUsername === GUEST;
  const showSignIn = isGuest && !!signInActions?.length;
  const showSignOut = !isGuest && !!signOutActions?.length;
  const pressable = !!pressActions?.length;

  const variant = showSignIn ? 'guest' : 'identity';

  const identity = (
    <>
      <span className="hmi-user-badge__avatar" aria-hidden="true">
        {initialsOf(usernameText)}
      </span>
      <span className="hmi-user-badge__text">
        <span className="hmi-user-badge__username">{usernameText}</span>
        {showGroups && <span className="hmi-user-badge__groups">{groupsText}</span>}
      </span>
    </>
  );

  return (
    <div className={`hmi-component hmi-user-badge hmi-user-badge--${variant}`} style={style}>
      {showSignIn ? (
        <button
          type="button"
          className="hmi-user-badge__action hmi-user-badge__signin"
          onClick={() => run(signInActions)}
        >
          <span className="hmi-user-badge__glyph" aria-hidden="true">
            <IconGlyph name={signInIcon} />
          </span>
          <span className="hmi-user-badge__signin-label">{signInLabel}</span>
        </button>
      ) : (
        <>
          {pressable ? (
            <button
              type="button"
              className="hmi-user-badge__identity hmi-user-badge__identity--pressable"
              onClick={() => run(pressActions)}
            >
              {identity}
            </button>
          ) : (
            <div className="hmi-user-badge__identity">{identity}</div>
          )}
          {showSignOut && (
            <button
              type="button"
              className="hmi-user-badge__action hmi-user-badge__signout"
              aria-label={signOutLabel}
              onClick={() => run(signOutActions)}
            >
              <span className="hmi-user-badge__glyph" aria-hidden="true">
                <IconGlyph name={signOutIcon} />
              </span>
            </button>
          )}
        </>
      )}
    </div>
  );
}
