import { fireEvent, render, screen } from '@testing-library/react';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import type { SchemaField } from '@shared/types/widgetSchema';
import FieldGroup, { FieldHeaderActions } from './index';

const SCHEMA: SchemaField = { type: 'string', label: 'Speed' };

function click(el: HTMLElement) {
  fireEvent.mouseDown(el);
  fireEvent.click(el);
}

beforeEach(() => {
  useEditorDomainStore.getState().setSelectedParam(null);
});

describe('FieldGroup — click state machine', () => {
  it('click-1 selects without focusing the control; click-2 focuses it (discovered inside the content slot, no ref wiring needed)', () => {
    render(
      <FieldGroup label="Speed" tier={1} selection={{ path: ['speed'], schema: SCHEMA }}>
        <input aria-label="Speed" defaultValue="10" />
      </FieldGroup>,
    );
    const row = document.querySelector('.cfg-field-group__row') as HTMLElement;
    const input = screen.getByLabelText('Speed');

    click(row);
    expect(useEditorDomainStore.getState().selectedParam?.path).toEqual(['speed']);
    expect(document.activeElement).not.toBe(input);

    click(row);
    expect(document.activeElement).toBe(input);
  });

  it('without a selection prop, the first click activates the control directly', () => {
    render(
      <FieldGroup label="Speed" tier={1}>
        <input aria-label="Speed" defaultValue="10" />
      </FieldGroup>,
    );
    const row = document.querySelector('.cfg-field-group__row') as HTMLElement;
    const input = screen.getByLabelText('Speed');

    click(row);
    expect(document.activeElement).toBe(input);
  });

  it('tier-2 click-2 focuses the discovered control — the app\'s Select renders a button (role="combobox"), not a native <select>', () => {
    render(
      <FieldGroup label="Mode" tier={2} selection={{ path: ['mode'], schema: SCHEMA }}>
        <button type="button" role="combobox" aria-label="Mode">
          A
        </button>
      </FieldGroup>,
    );
    const row = document.querySelector('.cfg-field-group__row') as HTMLElement;
    const trigger = screen.getByRole('combobox', { name: 'Mode' });

    click(row); // select
    click(row); // activate
    expect(document.activeElement).toBe(trigger);
  });

  it('tier-3 click-2 toggles expand and swaps summary for the nested content', () => {
    render(
      <FieldGroup
        label="Condition"
        tier={3}
        selection={{ path: ['cond'], schema: SCHEMA }}
        summary={<span>if(…)</span>}
      >
        <div>Nested body</div>
      </FieldGroup>,
    );
    const row = document.querySelector('.cfg-field-group__row') as HTMLElement;

    expect(screen.getByText('if(…)')).toBeInTheDocument();
    expect(screen.queryByText('Nested body')).not.toBeInTheDocument();

    click(row); // select
    click(row); // expand
    expect(screen.queryByText('if(…)')).not.toBeInTheDocument();
    expect(screen.getByText('Nested body')).toBeInTheDocument();
  });

  it('the Ctrl+C guard keeps the input non-editable-target after click-1 selects', () => {
    render(
      <FieldGroup label="Speed" tier={1} selection={{ path: ['speed'], schema: SCHEMA }}>
        <input aria-label="Speed" defaultValue="10" />
      </FieldGroup>,
    );
    const row = document.querySelector('.cfg-field-group__row') as HTMLElement;

    click(row);
    // document.activeElement stays <body> (or non-editable) — a subsequent
    // Ctrl+C is still handled by the app shortcut, not swallowed as a
    // text-field copy.
    expect(document.activeElement?.tagName).not.toBe('INPUT');
  });

  it('sourceless hides the badge even when one is passed', () => {
    render(
      <FieldGroup
        label="Name"
        tier={1}
        sourceless
        badge={<span data-testid="badge">V</span>}
        selection={{ path: ['name'], schema: SCHEMA }}
      >
        <input aria-label="Name" defaultValue="Pump" />
      </FieldGroup>,
    );
    expect(screen.queryByTestId('badge')).not.toBeInTheDocument();
  });

  it('renders the badge and an invalid dot when not sourceless', () => {
    render(
      <FieldGroup
        label="Name"
        tier={1}
        badge={<span data-testid="badge">V</span>}
        diagnostic={{ level: 'error', message: 'Unresolved binding' }}
        selection={{ path: ['name'], schema: SCHEMA }}
      >
        <input aria-label="Name" defaultValue="Pump" />
      </FieldGroup>,
    );
    const badge = screen.getByTestId('badge').parentElement;
    expect(badge).toHaveClass('cfg-field-group__badge--invalid');
    expect(badge).toHaveAttribute('title', 'Unresolved binding');
  });
});

describe('FieldHeaderActions', () => {
  function addButton() {
    return (
      <FieldHeaderActions>
        <button data-testid="add">Add</button>
      </FieldHeaderActions>
    );
  }

  it('portals into the nearest labelled ancestor’s title row through an unlabelled group', () => {
    render(
      <FieldGroup label="Menu items" tier={1}>
        <FieldGroup tier={1}>{addButton()}</FieldGroup>
      </FieldGroup>,
    );
    const titleRow = document.querySelector(
      '.cfg-field-group__header .cfg-field-group__header-actions',
    );

    expect(titleRow).toContainElement(screen.getByTestId('add'));
  });

  it('renders in place when no labelled ancestor exists', () => {
    render(<FieldGroup tier={1}>{addButton()}</FieldGroup>);

    expect(document.querySelector('.cfg-field-group__header')).toBeNull();
    expect(screen.getByTestId('add').parentElement).toHaveClass('cfg-field-group__header-actions');
  });
});
