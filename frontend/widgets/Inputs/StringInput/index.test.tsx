import '../../testSdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useComponentPropStore } from '@hmi/store/widgetPropStore';
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
    await user.click(document.querySelector<HTMLElement>('.hmi-virtual-input__close')!);
    expect(field).toHaveFocus();
    expect(document.querySelector('.hmi-virtual-input__close')).not.toBeInTheDocument();

    await user.click(field);
    expect(document.querySelector<HTMLElement>('.hmi-virtual-input__close')!).toBeInTheDocument();
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
});
