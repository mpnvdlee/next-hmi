/* @jsxRuntime classic */
import { ContainerBox } from '../Container/ContainerBox';
import { usePress } from '../../usePress';

// The Container fields are repeated, not imported: the schema extractor reads
// each widget's schema as a literal.
export const schema = {
  title: { type: 'string' as const, label: 'Title', group: 'Content' },
  showWhenEmpty: {
    type: 'boolean' as const,
    format: 'show' as const,
    label: 'Show when empty',
    group: 'Content',
    defaultValue: false,
    description:
      'Keep the frame and background even when every child is hidden, instead of collapsing away.',
  },
  overflow: {
    type: 'string' as const,
    format: 'select' as const,
    label: 'Overflow',
    group: 'Content',
    defaultValue: 'visible',
    options: [
      { label: 'Visible', value: 'visible' },
      { label: 'Clip', value: 'clip' },
      { label: 'Scroll', value: 'scroll' },
    ],
    description:
      'What happens to children that do not fit. Clip and Scroll need a bounded size (Fixed or Fill); a Hug container grows to fit its children instead.',
  },
  background: { type: 'color' as const, label: 'Background', group: 'Appearance' },
  border: {
    type: 'string' as const,
    label: 'Border',
    defaultValue: 'none',
    description: 'Any CSS border shorthand, e.g. 1px solid var(--hmi-border).',
    group: 'Appearance',
  },
  actions: { type: 'actions' as const, label: 'Actions' },
  onRelease: { type: 'actions' as const, label: 'On Released', event: 'onRelease' },
};

export const displayName = 'Button Container';
export const description =
  'A Container that is one big control around whatever it holds — a tile, a list row — running actions when pressed and released.';
export const category = 'Layout & structure';
export const icon = { type: 'builtin', name: 'cursor-click' } as const;
export const hostsChildren = true;
export const flowsChildren = true;

export default function ButtonContainer(props: HmiWidgetProps) {
  const evalCtx = useEvalContext();
  const scope = useHmiScope();
  const onPress = (props.properties?.actions as ActionsConfig | undefined)?.onPress;
  const onRelease = (props.properties?.onRelease as ActionsConfig | undefined)?.onRelease;
  const pressHandlers = usePress(
    (el) => executeWidgetActions(onPress, { scope, evalCtx, anchorEl: el }),
    (el) => executeWidgetActions(onRelease, { scope, evalCtx, anchorEl: el }),
    // A press on a control inside (a Button, an input, a nested Button
    // Container) belongs to that control, not to this one as well.
    (e) =>
      (e.target as Element).closest('button, a, input, select, textarea, [role="button"]') ===
      e.currentTarget,
  );
  return (
    <ContainerBox
      {...props}
      rootProps={{
        className: 'hmi-container--pressable',
        role: 'button',
        tabIndex: 0,
        ...pressHandlers,
      }}
    />
  );
}
