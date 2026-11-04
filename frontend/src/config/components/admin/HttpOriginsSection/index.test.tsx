import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HttpOriginsSection from './index';

function renderSection(
  props: Partial<React.ComponentProps<typeof HttpOriginsSection>> = {},
  saved = true,
) {
  const onSave = vi.fn().mockResolvedValue(saved);
  render(<HttpOriginsSection origins={[]} error={null} onSave={onSave} {...props} />);
  return { onSave, input: screen.getByRole('textbox', { name: 'Origin to add' }) };
}

describe('HttpOriginsSection', () => {
  it('says when nothing is listed', () => {
    renderSection();

    expect(screen.getByText('No origins listed.')).toBeInTheDocument();
  });

  it('adds a typed origin on Enter, trimmed, after the ones already listed', async () => {
    const { onSave, input } = renderSection({ origins: ['http://plc.local:80'] });

    await userEvent.type(input, '  https://10.0.0.5:8443 {Enter}');

    expect(onSave).toHaveBeenCalledWith(['http://plc.local:80', 'https://10.0.0.5:8443']);
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('adds with the Add button too', async () => {
    const { onSave, input } = renderSection();

    await userEvent.type(input, 'http://plc.local');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(onSave).toHaveBeenCalledWith(['http://plc.local']);
  });

  it('keeps the typed text when the backend refuses it', async () => {
    const { onSave, input } = renderSection({}, false);

    await userEvent.type(input, 'http://localhost{Enter}');

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('http://localhost');
  });

  it('saves nothing for a blank entry', async () => {
    const { onSave, input } = renderSection();

    await userEvent.type(input, '   {Enter}');

    expect(onSave).not.toHaveBeenCalled();
  });

  it('removes one origin with a single save, keeping a typed draft', async () => {
    const { onSave, input } = renderSection({
      origins: ['http://a.local:80', 'http://b.local:80'],
    });

    await userEvent.type(input, 'http://c.local');
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(['http://b.local:80']);
    expect(input).toHaveValue('http://c.local');
  });

  it('blocks a second change while one is saving', async () => {
    let finish!: (saved: boolean) => void;
    const onSave = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    render(
      <HttpOriginsSection
        origins={['http://a.local:80', 'http://b.local:80']}
        error={null}
        onSave={onSave}
      />,
    );

    const [removeA, removeB] = screen.getAllByRole('button', { name: 'Remove' });
    await userEvent.click(removeA);
    expect(removeB).toBeDisabled();
    finish(true);
    await waitFor(() => expect(removeB).toBeEnabled());
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('shows the error the backend gave', () => {
    renderSection({ error: 'http://127.0.0.1:80 points at this machine' });

    expect(screen.getByText('http://127.0.0.1:80 points at this machine')).toBeInTheDocument();
  });
});
