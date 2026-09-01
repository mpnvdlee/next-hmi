// Renders real built-in widgets (Label); bind the SDK and resolve their modules.
import '../../testSdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { WidgetConfig } from '@shared/types/config';
import { PreviewContext } from '@shared/context/PreviewContext';
import { ComponentSlotContext } from '@hmi/context/ComponentSlotContext';
import { slotKeyOf } from '@shared/utils/componentSlots';
import ComponentSlot from './index';

function renderSlot(
  properties: Record<string, unknown>,
  content: Record<string, WidgetConfig[]> | null,
) {
  return render(
    <MemoryRouter>
      <ComponentSlotContext.Provider value={content}>
        <ComponentSlot properties={properties} />
      </ComponentSlotContext.Provider>
    </MemoryRouter>,
  );
}

function label(id: string, text: string): WidgetConfig {
  return { id, type: 'Label', name: text, properties: { text } };
}

describe('ComponentSlot', () => {
  it('renders the widgets the caller put in its slot', async () => {
    renderSlot({ slot: 'body' }, { body: [label('a', 'First'), label('b', 'Second')] });
    // Label is a built-in widget: its module is lazy, so the first render suspends.
    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('renders only its own slot', () => {
    renderSlot({ slot: 'header' }, { header: [label('a', 'Title')], body: [label('b', 'Body')] });
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
  });

  it('falls back to the default slot name when unnamed', () => {
    renderSlot({}, { content: [label('a', 'Default')] });
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('renders nothing when the slot is empty or unfilled', () => {
    const cases: (Record<string, WidgetConfig[]> | null)[] = [null, {}, { body: [] }];
    for (const content of cases) {
      const { container } = renderSlot({ slot: 'body' }, content);
      expect(container).toBeEmptyDOMElement();
    }
  });

  // The widget's own slotKeyOf is a render-time twin of the shared one (a
  // widget module carries no app imports — see index.tsx) — pin it against the
  // shared implementation's own verdict so the two can't quietly diverge.
  it('resolves the slot name exactly as the shared slotKeyOf would', () => {
    const cases: unknown[] = ['body', '  header  ', '', '   ', undefined, 42];
    for (const raw of cases) {
      const key = slotKeyOf(raw);
      const { unmount } = renderSlot({ slot: raw }, { [key]: [label('a', 'Content')] });
      expect(screen.getByText('Content')).toBeInTheDocument();
      unmount();
    }
  });

  it('outlines an unfilled slot in the editor preview only', () => {
    // Without it a definition being authored has nothing to show and the shell
    // around the slot collapses; on a real HMI an unfilled slot is just absent.
    const { container } = render(
      <MemoryRouter>
        <PreviewContext.Provider value={true}>
          <ComponentSlotContext.Provider value={null}>
            <ComponentSlot properties={{ slot: 'body' }} />
          </ComponentSlotContext.Provider>
        </PreviewContext.Provider>
      </MemoryRouter>,
    );
    expect(container.textContent).toBe('Body');
  });
});
