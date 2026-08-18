import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import type { SchemaField } from '@shared/types/widgetSchema';
import { BranchEditor } from './shared';

const SCHEMA: SchemaField = { type: 'string', label: 'Value' };

beforeEach(() => {
  useEditorDomainStore.getState().setSelectedParam(null);
});

// A tier-3 (multi-field) value — the drawer only applies to tier-3 branches
// (redesign doc's Content-tier model); a plain static/var leaf branch has
// no drawer trigger at all, see the dedicated test below.
const RANDOM_VALUE = { $random: { min: 0, max: 100, integer: true } };

describe('CollapsibleExpressionCard — ⤢ drawer', () => {
  it('opens the field editor in a FieldDrawer while the inline row stays collapsed', () => {
    render(
      <BranchEditor label="When True" value={RANDOM_VALUE} onChange={vi.fn()} schema={SCHEMA} />,
    );

    // Composite branches start collapsed (session expand store empty on mount):
    // the inline row shows a preview, no live editor.
    expect(screen.queryByRole('heading', { name: 'When True' })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('100')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Expand in drawer'));

    expect(screen.getByRole('heading', { name: 'When True' })).toBeInTheDocument();
    // only the drawer's copy renders the live editor.
    expect(screen.getAllByDisplayValue('100')).toHaveLength(1);
  });

  it('closes on the drawer close button, returning to the collapsed inline row', () => {
    render(
      <BranchEditor label="When True" value={RANDOM_VALUE} onChange={vi.fn()} schema={SCHEMA} />,
    );

    fireEvent.click(screen.getByTitle('Expand in drawer'));
    expect(screen.getByRole('heading', { name: 'When True' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('100')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('heading', { name: 'When True' })).not.toBeInTheDocument();
    // inline row is back to its collapsed preview — no live editor mounted.
    expect(screen.queryByDisplayValue('100')).not.toBeInTheDocument();
  });

  it('a tier-1 leaf branch (e.g. a plain static value) has no drawer button', () => {
    render(<BranchEditor label="When True" value="hello" onChange={vi.fn()} schema={SCHEMA} />);

    expect(screen.queryByTitle('Expand in drawer')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('hello')).toBeInTheDocument();
  });
});
