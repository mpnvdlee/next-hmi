/* @jsxRuntime classic */
import { ContainerBox } from './ContainerBox';

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
};

export const description =
  'Groups and lays out child widgets in a row or column. Hosts other widgets; a Button Container does the same and runs actions when pressed.';
export const category = 'Layout & structure';
export const icon = { type: 'builtin', name: 'stack' } as const;
/** Nodes of this type carry a `children` array; the renderer hands them in
 *  already rendered, and the editor treats the node as a drop target. */
export const hostsChildren = true;
/** Those children are laid out with flexbox, off `containerLayoutProps` in `ContainerBox` —
 *  so each of them has a resolvable main axis and can be sized Hug/Fill/Fixed
 *  against it. A host that pins its children instead (`ImageContainer`) hosts
 *  without flowing, and declares only `hostsChildren`. */
export const flowsChildren = true;

export default function Container(props: HmiWidgetProps) {
  return <ContainerBox {...props} />;
}
