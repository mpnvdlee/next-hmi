import '../../testSdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  PageGroupStackContext,
  type PageGroupStackEntry,
} from '@hmi/components/PageGroupStackContext';
import PageNavigator from './index';

const PLANT = {
  id: 'plant',
  type: 'page-group' as const,
  title: 'Plant',
  children: [
    { id: 'line-1', type: 'page' as const, title: 'Line 1', sections: {} },
    { id: 'line-2', type: 'page' as const, title: 'Line 2', sections: {} },
  ],
};

const LINE = {
  id: 'line',
  type: 'page-group' as const,
  title: 'Filling Line',
  children: [
    { id: 'overview', type: 'page' as const, title: 'Overview', sections: {} },
    { id: 'trends', type: 'page' as const, title: 'Trends', sections: {} },
    { id: 'alarms', type: 'page' as const, title: 'Alarms', sections: {} },
  ],
};

const SOLO = {
  id: 'solo',
  type: 'page-group' as const,
  title: 'Solo',
  children: [{ id: 'only', type: 'page' as const, title: 'Only', sections: {} }],
};

const onNavigate = vi.fn();
const onPlantNavigate = vi.fn();

type Group = typeof LINE;

function entry(group: Group, activeId: string, handler = onNavigate): PageGroupStackEntry {
  return {
    group,
    activePage: group.children.find((c) => c.id === activeId) ?? { id: activeId },
    onNavigate: handler,
  } as unknown as PageGroupStackEntry;
}

function renderNavigator(
  properties: Record<string, unknown> = {},
  stack: PageGroupStackEntry[] = [entry(LINE, 'trends')],
) {
  return render(
    <MemoryRouter>
      <PageGroupStackContext.Provider value={stack}>
        <PageNavigator properties={properties} />
      </PageGroupStackContext.Provider>
    </MemoryRouter>,
  );
}

const prevButton = () => screen.getByRole('button', { name: 'Previous page' });
const nextButton = () => screen.getByRole('button', { name: 'Next page' });

describe('PageNavigator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with no properties set', () => {
    const { container } = renderNavigator({});
    expect(container.querySelector('.hmi-page-navigator')).not.toBeNull();
  });

  it('roots itself in an element carrying both the base and widget classes', () => {
    const { container } = renderNavigator({});
    // `hmi-component` is the self-layout barrier: it is the only consumer of the
    // `--self-*` properties `selfLayoutStyle()` emits, so without it every
    // layout field the author sets in the editor is silently inert.
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('hmi-component');
    expect(root.className).toContain('hmi-page-navigator');
  });

  it('offers a previous and a next control, both live mid-group', () => {
    renderNavigator({});
    expect(prevButton()).toBeEnabled();
    expect(nextButton()).toBeEnabled();
  });

  it('navigates to the preceding sibling page', async () => {
    const user = userEvent.setup();
    renderNavigator({});
    await user.click(prevButton());
    expect(onNavigate).toHaveBeenCalledWith('overview');
  });

  it('navigates to the following sibling page', async () => {
    const user = userEvent.setup();
    renderNavigator({});
    await user.click(nextButton());
    expect(onNavigate).toHaveBeenCalledWith('alarms');
  });

  it('disables previous on the first page of the group', () => {
    renderNavigator({}, [entry(LINE, 'overview')]);
    expect(prevButton()).toBeDisabled();
    expect(nextButton()).toBeEnabled();
  });

  it('disables next on the last page of the group', () => {
    renderNavigator({}, [entry(LINE, 'alarms')]);
    expect(prevButton()).toBeEnabled();
    expect(nextButton()).toBeDisabled();
  });

  it('disables both controls in a single-page group', () => {
    renderNavigator({}, [entry(SOLO, 'only')]);
    expect(prevButton()).toBeDisabled();
    expect(nextButton()).toBeDisabled();
  });

  it('walks the innermost group when no target is configured', async () => {
    const user = userEvent.setup();
    renderNavigator({}, [entry(PLANT, 'line-1', onPlantNavigate), entry(LINE, 'trends')]);
    await user.click(nextButton());
    expect(onNavigate).toHaveBeenCalledWith('alarms');
    expect(onPlantNavigate).not.toHaveBeenCalled();
  });

  it('walks the named group instead when one is configured', async () => {
    const user = userEvent.setup();
    renderNavigator({ groupId: 'plant' }, [
      entry(PLANT, 'line-1', onPlantNavigate),
      entry(LINE, 'trends'),
    ]);
    await user.click(nextButton());
    expect(onPlantNavigate).toHaveBeenCalledWith('line-2');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('walks the enclosing group for the $parent target', async () => {
    const user = userEvent.setup();
    renderNavigator({ groupId: '$parent' }, [
      entry(PLANT, 'line-1', onPlantNavigate),
      entry(LINE, 'trends'),
    ]);
    await user.click(nextButton());
    expect(onPlantNavigate).toHaveBeenCalledWith('line-2');
  });

  it('renders nothing when $parent has no enclosing group', () => {
    const { container } = renderNavigator({ groupId: '$parent' });
    expect(container.querySelector('.hmi-page-navigator')).toBeNull();
  });

  it('renders nothing when the named group is not on the stack', () => {
    const { container } = renderNavigator({ groupId: 'nope' });
    expect(container.querySelector('.hmi-page-navigator')).toBeNull();
  });

  it('renders nothing outside a page group', () => {
    const { container } = render(
      <MemoryRouter>
        <PageNavigator properties={{}} />
      </MemoryRouter>,
    );
    expect(container.querySelector('.hmi-page-navigator')).toBeNull();
  });

  it('offers only a way back in when the active page is not in the group', async () => {
    const user = userEvent.setup();
    renderNavigator({}, [entry(LINE, 'stranger')]);
    expect(prevButton()).toBeDisabled();
    await user.click(nextButton());
    expect(onNavigate).toHaveBeenCalledWith('overview');
  });
});
