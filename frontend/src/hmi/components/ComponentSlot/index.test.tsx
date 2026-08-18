// Renders real stdlib widgets (Label); bind the SDK and resolve their modules.
import '../../../../widgets/testSdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { WidgetConfig } from '@shared/types/config';
import { PreviewContext } from '@shared/context/PreviewContext';
import { ComponentSlotContext } from '../../context/ComponentSlotContext';
import ComponentSlot from './index';
import { collectSlotKeys, groupChildrenBySlot } from './slotKey';

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
    // Label is a stdlib widget: its module is lazy, so the first render suspends.
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

describe('collectSlotKeys', () => {
  it('collects slot names in tree order, at any depth, deduped', () => {
    const definition: WidgetConfig[] = [
      { id: 's1', type: 'ComponentSlot', name: '', properties: { slot: 'header' } },
      {
        id: 'box',
        type: 'Container',
        name: '',
        children: [
          { id: 's2', type: 'ComponentSlot', name: '', properties: { slot: 'body' } },
          { id: 's3', type: 'ComponentSlot', name: '', properties: { slot: 'header' } },
          { id: 's4', type: 'ComponentSlot', name: '' },
        ],
      },
    ];
    expect(collectSlotKeys(definition)).toEqual(['header', 'body', 'content']);
  });

  it('is empty for a definition with no slots', () => {
    expect(collectSlotKeys([{ id: 'a', type: 'Label', name: '' }])).toEqual([]);
  });
});

describe('groupChildrenBySlot', () => {
  const slots = ['header', 'body'];

  it('groups by tag and keeps every slot present', () => {
    const grouped = groupChildrenBySlot(
      [
        { ...label('a', 'A'), slot: 'body' },
        { ...label('b', 'B'), slot: 'header' },
      ],
      slots,
    );
    expect(grouped.header.map((c) => c.id)).toEqual(['b']);
    expect(grouped.body.map((c) => c.id)).toEqual(['a']);
  });

  it('sends untagged and stale-tagged children to the first slot', () => {
    // A definition that drops a slot must not make the content vanish.
    const grouped = groupChildrenBySlot(
      [label('a', 'A'), { ...label('b', 'B'), slot: 'gone' }],
      slots,
    );
    expect(grouped.header.map((c) => c.id)).toEqual(['a', 'b']);
    expect(grouped.body).toEqual([]);
  });

  it('drops everything when the definition declares no slots', () => {
    expect(groupChildrenBySlot([label('a', 'A')], [])).toEqual({});
  });

  it('treats a tag naming a prototype member as stale, not as a slot', () => {
    const grouped = groupChildrenBySlot([{ ...label('a', 'A'), slot: 'toString' }], slots);
    expect(grouped.header.map((c) => c.id)).toEqual(['a']);
  });
});
