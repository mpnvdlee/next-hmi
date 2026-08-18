import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import CustomWidgetsSection from './index';
import type { CustomWidgetStatus } from '@config/store/adminViewStore';

function widget(overrides: Partial<CustomWidgetStatus> = {}): CustomWidgetStatus {
  return {
    key: 'Inputs/Dial',
    name: 'Dial',
    group: 'Inputs',
    hasStyle: true,
    buildOk: true,
    buildError: null,
    buildTs: null,
    ...overrides,
  };
}

function renderSection(props: Partial<React.ComponentProps<typeof CustomWidgetsSection>> = {}) {
  const onRecompileAll = vi.fn();
  const onRecompile = vi.fn();
  const view = render(
    <MemoryRouter>
      <CustomWidgetsSection
        widgets={[]}
        recompiling={[]}
        error={null}
        onRecompileAll={onRecompileAll}
        onRecompile={onRecompile}
        {...props}
      />
    </MemoryRouter>,
  );
  return { ...view, onRecompileAll, onRecompile };
}

/** Table row for a widget, addressed by its canonical key. */
function row(key: string): HTMLElement {
  return screen.getByText(key, { selector: 'td' }).closest('tr') as HTMLElement;
}

describe('CustomWidgetsSection', () => {
  it('explains the empty state and disables Recompile all', () => {
    renderSection();

    expect(screen.getByText(/No custom widgets found/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recompile all' })).toBeDisabled();
  });

  it('lists widgets by their canonical key so duplicate leaf names stay distinct', () => {
    renderSection({
      widgets: [widget(), widget({ key: 'Other/Dial', group: 'Other' })],
    });

    expect(screen.getByText('Inputs/Dial', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText('Other/Dial', { selector: 'td' })).toBeInTheDocument();
  });

  it('renders the three build states distinctly', () => {
    renderSection({
      widgets: [
        widget({ key: 'A', buildOk: true }),
        widget({ key: 'B', buildOk: false, buildError: 'boom' }),
        widget({ key: 'C', buildOk: null }),
      ],
    });

    expect(within(row('A')).getByText('OK')).toBeInTheDocument();
    expect(within(row('B')).getByText('Error')).toBeInTheDocument();
    expect(within(row('C')).getByText('Unknown')).toBeInTheDocument();
  });

  it('reports whether a widget ships a stylesheet', () => {
    renderSection({
      widgets: [widget({ key: 'A', hasStyle: true }), widget({ key: 'B', hasStyle: false })],
    });

    expect(within(row('A')).getByText('Yes')).toBeInTheDocument();
    expect(within(row('B')).getByText('No')).toBeInTheDocument();
  });

  it('dashes the compiled column when the widget has never been built', () => {
    renderSection({ widgets: [widget({ buildTs: null })] });

    expect(within(row('Inputs/Dial')).getByText('—')).toBeInTheDocument();
  });

  it('recompiles a single widget by its canonical key', async () => {
    const { onRecompile } = renderSection({ widgets: [widget()] });

    await userEvent.click(within(row('Inputs/Dial')).getByRole('button', { name: 'Recompile' }));

    expect(onRecompile).toHaveBeenCalledWith('Inputs/Dial');
  });

  it('recompiles every widget from the section action', async () => {
    const { onRecompileAll } = renderSection({ widgets: [widget()] });

    await userEvent.click(screen.getByRole('button', { name: 'Recompile all' }));

    expect(onRecompileAll).toHaveBeenCalled();
  });

  it('locks every row while a single widget is recompiling', () => {
    renderSection({
      widgets: [widget({ key: 'A' }), widget({ key: 'B' })],
      recompiling: ['A'],
    });

    expect(within(row('A')).getByRole('button', { name: 'Recompiling…' })).toBeDisabled();
    expect(within(row('B')).getByRole('button', { name: 'Recompile' })).toBeDisabled();
  });

  it('marks every row busy during a recompile-all run', () => {
    renderSection({ widgets: [widget({ key: 'A' }), widget({ key: 'B' })], recompiling: ['*'] });

    expect(screen.getAllByRole('button', { name: 'Recompiling…' })).toHaveLength(3);
    expect(within(row('A')).getByRole('button', { name: 'Recompiling…' })).toBeDisabled();
    expect(within(row('B')).getByRole('button', { name: 'Recompiling…' })).toBeDisabled();
  });

  it('shows the recompile transport error above the table', () => {
    renderSection({ widgets: [widget()], error: 'Error: 500 compile service down' });

    expect(screen.getByText('Error: 500 compile service down')).toBeInTheDocument();
  });

  it('groups build errors into one collapsible block per failing widget', () => {
    renderSection({
      widgets: [
        widget({ key: 'A', buildOk: true }),
        widget({ key: 'B', buildOk: false, buildError: 'B: Unexpected token' }),
        widget({ key: 'C', buildOk: false, buildError: 'C: Unexpected token' }),
      ],
    });

    const details = document.querySelectorAll('details.cfg-admin-error-detail');
    expect(details).toHaveLength(2);
    expect(screen.getByText('B: Unexpected token')).toBeInTheDocument();
    expect(screen.getByText('C: Unexpected token')).toBeInTheDocument();
  });

  it('omits the error block entirely when every widget built', () => {
    renderSection({ widgets: [widget()] });

    expect(document.querySelector('details.cfg-admin-error-detail')).toBeNull();
  });

  it('links to the token browser and names the deduplicated HMI tokens in the error', () => {
    renderSection({
      widgets: [
        widget({
          key: 'A',
          buildOk: false,
          buildError: 'unknown var --hmi-accent, --hmi-bg-2 and again --hmi-accent',
        }),
      ],
    });

    expect(screen.getByText('--hmi-accent, --hmi-bg-2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Browse available tokens/ })).toHaveAttribute(
      'href',
      '/config/admin#theme-tokens',
    );
  });

  it('leaves out the token hint for an error that names no HMI token', () => {
    renderSection({
      widgets: [widget({ key: 'A', buildOk: false, buildError: 'Unexpected token }' })],
    });

    expect(screen.queryByText(/This error references HMI token/)).toBeNull();
  });
});
