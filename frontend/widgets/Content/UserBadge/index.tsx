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
  actions: { type: 'actions' as const, label: 'On Press', group: 'Actions' },
};

export const displayName = 'User Badge';
export const description = 'Shows the currently signed-in user as an initialled badge.';
export const category = 'Content & controls';
export const icon = { type: 'builtin', name: 'user' } as const;

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

export default function UserBadge({ properties, layout }: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const scope = useHmiScope();
  const actions = properties?.actions as ActionsConfig | undefined;

  const defaultUsername = evalCtx.resolveUser?.('username') ?? 'guest';
  const defaultGroups = evalCtx.resolveUser?.('groups') ?? 'guest';

  const usernameText = getPropString(properties, 'usernameText', defaultUsername, evalCtx);
  const groupsText = getPropString(properties, 'groupsText', defaultGroups, evalCtx);

  return (
    <div
      className="hmi-component hmi-user-badge"
      style={selfLayoutStyle(layout)}
      onClick={() => executeWidgetActions(actions?.onPress, { scope, evalCtx })}
    >
      <span className="hmi-user-badge__avatar">{initialsOf(usernameText)}</span>
      <span className="hmi-user-badge__text">
        <span className="hmi-user-badge__username">{usernameText}</span>
        <span className="hmi-user-badge__groups">{groupsText}</span>
      </span>
    </div>
  );
}
