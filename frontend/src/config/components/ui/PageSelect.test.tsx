import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfigStore } from '@shared/store/configStore';
import PageSelect from './PageSelect';

const page = (id: string, title: string) => ({
  id,
  type: 'page' as const,
  title,
  sections: { content: [] },
});

// jsdom has no layout, so the popup's scroll-into-view call needs a stub.
Element.prototype.scrollIntoView = vi.fn();

async function openList() {
  await userEvent.click(screen.getByRole('combobox'));
}

function optionTexts() {
  return screen.getAllByRole('option').map((o) => o.textContent);
}

describe('PageSelect', () => {
  beforeEach(() => {
    useConfigStore.setState({
      pages: [page('home', 'Home')],
      dialogs: [page('motor-detail', 'Motor detail')],
    });
  });

  it('leaves the Dialogs folder out of a field that navigates', async () => {
    render(<PageSelect value={undefined} onChange={() => {}} />);
    await openList();

    expect(optionTexts()).toContain('Home');
    expect(optionTexts()).not.toContain('Motor detail');
  });

  it('marks a Dialogs-folder page the field already names, rather than dropping it', async () => {
    render(<PageSelect value={{ $static: 'motor-detail' }} onChange={() => {}} />);
    await openList();

    expect(optionTexts()).toContain('Motor detail (overlay — not navigable)');
  });

  it('still reports an id that resolves nowhere as missing', async () => {
    render(<PageSelect value={{ $static: 'deleted-page' }} onChange={() => {}} />);
    await openList();

    expect(optionTexts()).toContain('deleted-page (missing)');
  });

  it('offers the Dialogs folder to a field that reads a page instead of going to it', async () => {
    render(<PageSelect value={undefined} onChange={() => {}} include="all" />);
    await openList();

    expect(optionTexts()).toContain('Motor detail');
    expect(document.querySelector('.cfg-select-popup__group')?.textContent).toBe('Dialogs');
  });

  it('keeps a Dialogs-folder id selected rather than reporting it missing', async () => {
    render(<PageSelect value={{ $static: 'motor-detail' }} onChange={() => {}} include="all" />);
    await openList();

    expect(screen.getByRole('combobox').textContent).toContain('Motor detail');
    expect(optionTexts()).not.toContain('motor-detail (missing)');
  });
});
