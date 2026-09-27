import type { WidgetConfig } from '@shared/types/config';
import { collectSlotKeys, groupChildrenBySlot } from './componentSlots';

function label(id: string, text: string): WidgetConfig {
  return { id, type: 'Label', name: text, properties: { text } };
}

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
