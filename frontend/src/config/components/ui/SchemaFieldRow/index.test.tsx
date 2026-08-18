import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SchemaField } from '@shared/types/widgetSchema';
import SchemaFieldRow from './index';

const DESC = 'Shown when the dot is not pulsing.';

/** The description must sit between the label and the field box — inside the
 *  box it would compete with the control for the content slot. */
function expectDescriptionAboveBox(text: string) {
  const desc = screen.getByText(text);
  expect(desc).toHaveClass('cfg-field-group__desc');
  const group = desc.closest('.cfg-field-group') as HTMLElement;
  const box = group.querySelector('.cfg-field-group__box');
  expect(box).not.toBeNull();
  expect(box!.contains(desc)).toBe(false);
  expect(desc.compareDocumentPosition(box!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

describe('SchemaFieldRow description', () => {
  it('renders a description on a sourced (tier-3) field', () => {
    const schema: SchemaField = { type: 'String', label: 'Text', description: DESC };
    render(<SchemaFieldRow schema={schema} value="hi" onChange={vi.fn()} propKey="text" />);

    expect(screen.getByText('Text')).toBeInTheDocument();
    expectDescriptionAboveBox(DESC);
  });

  it('renders a description on an editor-kind field that uses a bare PropRow', () => {
    const schema: SchemaField = {
      type: 'image-indicators',
      label: 'Indicators',
      description: DESC,
    };
    render(<SchemaFieldRow schema={schema} value={[]} onChange={vi.fn()} propKey="indicators" />);

    expect(screen.getByText('Indicators')).toBeInTheDocument();
    expectDescriptionAboveBox(DESC);
  });

  it('renders a description under an actions list, which has no box of its own', () => {
    const schema: SchemaField = { type: 'actions', label: 'Actions', description: DESC };
    render(
      <SchemaFieldRow schema={schema} value={undefined} onChange={vi.fn()} propKey="actions" />,
    );

    expect(screen.getByText(DESC)).toHaveClass('cfg-field-group__desc');
  });

  it('renders a description under a menu-items list, which has no box of its own', () => {
    const schema: SchemaField = { type: 'menu-items', label: 'Items', description: DESC };
    render(<SchemaFieldRow schema={schema} value={undefined} onChange={vi.fn()} propKey="items" />);

    expect(screen.getByText(DESC)).toHaveClass('cfg-field-group__desc');
    expect(screen.getByText('No items yet')).toBeInTheDocument();
  });

  it('omits the description element entirely when the schema declares none', () => {
    const schema: SchemaField = { type: 'String', label: 'Text' };
    const { container } = render(
      <SchemaFieldRow schema={schema} value="hi" onChange={vi.fn()} propKey="text" />,
    );

    expect(container.querySelector('.cfg-field-group__desc')).toBeNull();
  });
});

/** `evaluateVisibility` reads the raw property, ignoring schema defaults — which
 *  is what makes the NavigationMenu gate correct: `mode` defaults to `auto`, so
 *  an unset `mode` keeps the manual item list hidden until it is picked. */
describe('SchemaFieldRow menu-items visibility gate', () => {
  const schema: SchemaField = {
    type: 'menu-items',
    label: 'Items',
    visibleWhen: { property: 'mode', equals: 'manual' },
  };

  function renderGated(allProperties: Record<string, unknown>) {
    return render(
      <SchemaFieldRow
        schema={schema}
        value={undefined}
        onChange={vi.fn()}
        propKey="items"
        allProperties={allProperties}
      />,
    );
  }

  it('hides the list while mode is unset or auto', () => {
    expect(renderGated({}).container.querySelector('.cfg-menu-items')).toBeNull();
    expect(renderGated({ mode: 'auto' }).container.querySelector('.cfg-menu-items')).toBeNull();
  });

  it('shows the list once mode is manual', () => {
    expect(
      renderGated({ mode: 'manual' }).container.querySelector('.cfg-menu-items'),
    ).not.toBeNull();
  });
});

/** Every mixed row says the same word in the same muted hint span. */
function expectMixedHint() {
  expect(screen.getByText('Mixed')).toHaveClass('cfg-unset-hint');
}

describe('SchemaFieldRow mixed rows', () => {
  const mixed = { source: 'static' } as const;

  it('marks a mixed boolean row rather than showing its default as in effect', () => {
    const schema: SchemaField = {
      type: 'Boolean',
      format: 'wrap',
      label: 'Wrap',
      defaultValue: false,
    };
    render(
      <SchemaFieldRow
        schema={schema}
        value={undefined}
        onChange={vi.fn()}
        propKey="wrap"
        mixed={mixed}
      />,
    );

    const noWrap = screen.getByRole('button', { name: 'No wrap' });
    expect(noWrap).toHaveClass('cfg-seg-btn--alt');
    expect(noWrap).not.toHaveClass('cfg-seg-btn--default');
    expect(screen.getByRole('button', { name: 'Wrap' })).toHaveClass('cfg-seg-btn--alt');
    expectMixedHint();
  });

  it('marks a mixed select row rather than showing its default as in effect', () => {
    const schema: SchemaField = {
      type: 'String',
      format: 'align',
      label: 'Align items',
      display: 'button-text',
      defaultValue: 'stretch',
      options: [
        { label: 'Start', value: 'flex-start' },
        { label: 'Stretch', value: 'stretch' },
      ],
    };
    render(
      <SchemaFieldRow
        schema={schema}
        value={undefined}
        onChange={vi.fn()}
        propKey="align"
        mixed={mixed}
      />,
    );

    const stretch = screen.getByRole('button', { name: 'Stretch' });
    expect(stretch).not.toHaveClass('cfg-seg-btn--default');
    expect(stretch).not.toHaveClass('cfg-seg-btn--active');
    expect(stretch).toHaveClass('cfg-seg-btn--alt');
    expectMixedHint();
  });

  it('marks a mixed color row instead of naming the theme fallback', () => {
    const schema: SchemaField = { type: 'Color', label: 'Fill', defaultToken: '--hmi-accent' };
    render(
      <SchemaFieldRow
        schema={schema}
        value={undefined}
        onChange={vi.fn()}
        propKey="fill"
        mixed={mixed}
      />,
    );

    expect(screen.getByText('Mixed')).toBeInTheDocument();
    expect(screen.queryByText('Accent')).not.toBeInTheDocument();
    expect(screen.queryByText('· default')).not.toBeInTheDocument();
  });

  it('keeps the text row reading "Mixed" with no revert', () => {
    const schema: SchemaField = { type: 'String', label: 'Text', defaultValue: 'Hello' };
    render(
      <SchemaFieldRow
        schema={schema}
        value={undefined}
        onChange={vi.fn()}
        propKey="text"
        mixed={mixed}
      />,
    );

    expect(screen.getByPlaceholderText('Mixed')).toHaveValue('');
    expect(screen.queryByTitle(/^Revert to/)).not.toBeInTheDocument();
  });

  it('still marks the default on a plain unset row', () => {
    const schema: SchemaField = {
      type: 'Boolean',
      format: 'wrap',
      label: 'Wrap',
      defaultValue: false,
    };
    render(<SchemaFieldRow schema={schema} value={undefined} onChange={vi.fn()} propKey="wrap" />);

    expect(screen.getByRole('button', { name: 'No wrap' })).toHaveClass('cfg-seg-btn--default');
    expect(screen.queryByText('Mixed')).not.toBeInTheDocument();
  });
});

/** A mixed row has no value, so the source pill cannot read its badge off one —
 *  it must take the source the selection still shares, or say it has none. */
describe('SchemaFieldRow mixed source badge', () => {
  const schema: SchemaField = { type: 'String', label: 'Text', defaultValue: 'Hello' };

  function renderRow(mixed: { source: 'static' | '$var' | null }, onChange = vi.fn()) {
    render(
      <SchemaFieldRow
        schema={schema}
        value={undefined}
        onChange={onChange}
        propKey="text"
        mixed={mixed}
      />,
    );
    return onChange;
  }

  it('badges the source every selected widget shares', () => {
    renderRow({ source: '$var' });

    expect(screen.getByLabelText('Variable')).toBeInTheDocument();
    expect(screen.queryByLabelText('Static Value')).not.toBeInTheDocument();
  });

  it('badges "mixed" when the widgets disagree on the source', () => {
    renderRow({ source: null });

    expect(screen.getByLabelText('Mixed sources')).toBeInTheDocument();
    expect(screen.queryByLabelText('Static Value')).not.toBeInTheDocument();
  });

  // A struct row binds one way whatever else the selection disagrees about, and
  // `mixed.source` reads an unbound widget as `static` — a source the row does
  // not offer. Badging it would contradict the `$var` editor in the body.
  it('badges a mixed struct row with the binding its body renders', () => {
    const struct: SchemaField = { type: 'Alarms[]', label: 'Alarms' };
    render(
      <SchemaFieldRow
        schema={struct}
        value={undefined}
        onChange={vi.fn()}
        propKey="alarms"
        mixed={{ source: null }}
      />,
    );

    expect(screen.getByLabelText('Variable')).toBeInTheDocument();
    expect(screen.queryByLabelText('Mixed sources')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Static Value')).not.toBeInTheDocument();
  });

  it('gives a shared static value when Static is picked on a mixed static row', async () => {
    const onChange = renderRow({ source: 'static' });

    await userEvent.click(screen.getByLabelText('Static Value').closest('button')!);
    await userEvent.click(
      screen.getByText('Static Value', { selector: '.cfg-source-pill__option-label' }),
    );

    expect(onChange).toHaveBeenCalledWith('Hello');
  });
});
