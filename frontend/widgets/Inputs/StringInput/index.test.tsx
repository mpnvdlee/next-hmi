import '../../testSdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useComponentPropStore } from '@hmi/store/widgetPropStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { PreviewContext } from '@shared/context/PreviewContext';
import StringInput from './index';

function renderInput(properties: Record<string, unknown>, id = 'entry') {
  return render(
    <MemoryRouter>
      <StringInput id={id} properties={properties} />
    </MemoryRouter>,
  );
}

// jsdom parses no vendor property, so `CSS.supports` answers false for the mask
// and every password case would otherwise exercise the fallback path alone.
function stubCssMasking(supported: boolean) {
  vi.spyOn(CSS, 'supports').mockImplementation(
    (property: string) => supported && property === '-webkit-text-security',
  );
}

describe('StringInput', () => {
  beforeEach(() => {
    useComponentPropStore.setState({ props: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders with no properties at all', () => {
    const { container } = renderInput({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-component');
    expect(el.className).toContain('hmi-string-input');
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('publishes what the operator types as its `value` export', async () => {
    const user = userEvent.setup();
    renderInput({ label: 'Batch' });

    await user.type(screen.getByRole('textbox'), 'A17');

    expect(useComponentPropStore.getState().props.entry.value).toBe('A17');
  });

  it('reopens the keyboard on a second tap while the field still has focus', async () => {
    const user = userEvent.setup();
    renderInput({});

    const field = screen.getByRole('textbox');
    await user.click(field);
    await user.click(screen.getByRole('button', { name: 'Close keyboard' }));
    expect(field).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Close keyboard' })).not.toBeInTheDocument();

    await user.click(field);
    expect(screen.getByRole('button', { name: 'Close keyboard' })).toBeInTheDocument();
  });

  it('masks the field and toggles it with the reveal button', async () => {
    const user = userEvent.setup();
    stubCssMasking(true);
    const { container } = renderInput({ isPassword: true });

    const field = container.querySelector('.hmi-string-input__input') as HTMLInputElement;
    expect(field.className).toContain('hmi-string-input__input--masked');

    await user.click(screen.getByRole('button', { name: 'Show password' }));

    expect(field.className).not.toContain('hmi-string-input__input--masked');
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeInTheDocument();
  });

  it('stays invisible to the browser password manager while masked', () => {
    stubCssMasking(true);
    const { container } = renderInput({ isPassword: true });

    const field = container.querySelector('.hmi-string-input__input') as HTMLInputElement;
    expect(field.type).toBe('text');
    expect(field.autocomplete).toBe('off');
  });

  it('falls back to a real password field where the CSS mask is unsupported', () => {
    stubCssMasking(false);
    const { container } = renderInput({ isPassword: true });

    const field = container.querySelector('.hmi-string-input__input') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.className).not.toContain('hmi-string-input__input--masked');
  });

  it('disables the field and skips the reveal button when not a password', () => {
    renderInput({ disabled: true });

    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.queryByRole('button')).toBeNull();
  });

  describe('numeric keyboard', () => {
    it('opens the numpad, not the keyboard, and publishes the digits', async () => {
      const user = userEvent.setup();
      renderInput({ keyboard: 'numeric', label: 'PIN' });

      await user.click(screen.getByRole('textbox'));
      expect(screen.queryByRole('button', { name: 'Close keyboard' })).not.toBeInTheDocument();
      for (const key of ['0', '4', '2'])
        await user.click(screen.getByRole('button', { name: key }));

      expect(useComponentPropStore.getState().props.entry.value).toBe('042');
      expect(screen.getByRole('button', { name: '.' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '-' })).toBeDisabled();

      await user.click(screen.getByRole('button', { name: 'Enter' }));
      expect(screen.queryByRole('button', { name: 'Close numpad' })).not.toBeInTheDocument();
      expect(useComponentPropStore.getState().props.entry.value).toBe('042');
    });

    it('masks the numpad entry of a password field through CSS where supported', async () => {
      stubCssMasking(true);
      const user = userEvent.setup();
      renderInput({ keyboard: 'numeric', isPassword: true, label: 'PIN' });

      await user.click(screen.getByRole('textbox'));
      const entry = screen.getByLabelText('PIN', { selector: '.hmi-virtual-input__field' });

      expect(entry).toHaveClass('hmi-virtual-input__field--masked');
      expect(entry).toHaveAttribute('type', 'text');
    });

    it('falls back to a password numpad entry where the CSS mask is unsupported', async () => {
      stubCssMasking(false);
      const user = userEvent.setup();
      renderInput({ keyboard: 'numeric', isPassword: true, label: 'PIN' });

      await user.click(document.querySelector('.hmi-string-input__input') as HTMLElement);
      const entry = screen.getByLabelText('PIN', { selector: '.hmi-virtual-input__field' });

      expect(entry).toHaveAttribute('type', 'password');
    });
  });

  describe('PIN entry', () => {
    // The toast reads the field's own export, so it proves the actions see
    // the entered value, as a Login User password binding does.
    const toastValue = {
      onSubmit: [
        {
          type: 'showToast',
          message: { $widgetProp: { componentId: 'entry', property: 'value' } },
          severity: 'info',
          discard: 'auto',
        },
      ],
    };
    const toasts = () => useHmiStore.getState().pendingToasts.map((t) => t.message);

    beforeEach(() => {
      useHmiStore.setState({ pendingToasts: [] });
    });

    it('opens the numpad centred as soon as it appears with Focus when shown', () => {
      renderInput({ keyboard: 'numeric', autoFocus: true, label: 'PIN' });

      expect(screen.getByRole('button', { name: 'Close numpad' })).toBeInTheDocument();
      expect(document.querySelector('.hmi-virtual-input__dock--middle')).not.toBeNull();
    });

    it('does not open it in the editor canvas', () => {
      render(
        <MemoryRouter>
          <PreviewContext.Provider value={true}>
            <StringInput id="entry" properties={{ keyboard: 'numeric', autoFocus: true }} />
          </PreviewContext.Provider>
        </MemoryRouter>,
      );

      expect(screen.queryByRole('button', { name: 'Close numpad' })).not.toBeInTheDocument();
    });

    it('runs On Submit with the entered value on the numpad Enter, and closes it', async () => {
      const user = userEvent.setup();
      renderInput({ keyboard: 'numeric', autoFocus: true, onSubmit: toastValue });

      for (const key of ['1', '2', '3', '4'])
        await user.click(screen.getByRole('button', { name: key }));
      await user.click(screen.getByRole('button', { name: 'Enter' }));

      expect(toasts()).toEqual(['1234']);
      expect(screen.queryByRole('button', { name: 'Close numpad' })).not.toBeInTheDocument();
    });

    it('runs On Submit on Enter from a physical keyboard', async () => {
      const user = userEvent.setup();
      renderInput({ onSubmit: toastValue });

      await user.type(screen.getByRole('textbox'), 'A17{Enter}');

      expect(toasts()).toEqual(['A17']);
    });

    it('does not run On Submit when the numpad is closed with ×', async () => {
      const user = userEvent.setup();
      renderInput({ keyboard: 'numeric', autoFocus: true, onSubmit: toastValue });

      await user.click(screen.getByRole('button', { name: '7' }));
      await user.click(screen.getByRole('button', { name: 'Close numpad' }));

      expect(toasts()).toEqual([]);
    });
  });
});
