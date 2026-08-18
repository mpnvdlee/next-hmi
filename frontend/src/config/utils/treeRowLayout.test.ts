import { treePaddingLeft, treePaddingLeftWithOffset } from './treeRowLayout';

describe('treeRowLayout', () => {
  it('uses default indentation scale for datasource table rows', () => {
    expect(treePaddingLeft(0)).toBe('0.75rem');
    expect(treePaddingLeft(1)).toBe('1.95rem');
    expect(treePaddingLeft(3)).toBe('4.35rem');
  });

  it('supports custom indentation values for picker rows', () => {
    expect(treePaddingLeft(0, { stepRem: 1, baseRem: 0.5 })).toBe('0.5rem');
    expect(treePaddingLeft(2, { stepRem: 1, baseRem: 0.5 })).toBe('2.5rem');
  });

  it('builds calc expressions for offset-based row padding', () => {
    expect(treePaddingLeftWithOffset(0, '18px + 0.2rem')).toBe('calc(0.75rem + 18px + 0.2rem)');
    expect(treePaddingLeftWithOffset(2, '18px + 0.2rem')).toBe('calc(3.15rem + 18px + 0.2rem)');
  });
});
