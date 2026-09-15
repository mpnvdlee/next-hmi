import '../../testSdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useComponentPropStore } from '@hmi/store/widgetPropStore';
import StringInput from './index';

// The reveal button's glyph is a code-split Phosphor icon: a `React.lazy` over a
// dynamic import of the whole 130-icon module. `user.click` runs inside `act`,
// which waits for that import to resolve — ~2s on an idle machine, and past the
// 5s test timeout once a full run is competing for the CPU. Nothing here asserts
// which glyph renders (the Icon widget's own test covers the real loader), so
// stub the module and stop timing the bundler.
vi.mock('@shared/utils/phosphorIconComponents', () => ({
  BUILTIN_ICON_COMPONENTS: { eye: () => <svg />, 'eye-slash': () => <svg /> },
}));

function renderInput(properties: Record<string, unknown>, id = 'entry') {
  return render(
    <MemoryRouter>
      <StringInput id={id} properties={properties} />
    </MemoryRouter>,
  );
}

describe('StringInput', () => {
  beforeEach(() => {
    useComponentPropStore.setState({ props: {} });
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

  it('masks the field and toggles it with the reveal button', async () => {
    const user = userEvent.setup();
    const { container } = renderInput({ isPassword: true });

    const field = container.querySelector('.hmi-string-input__input') as HTMLInputElement;
    expect(field.type).toBe('password');

    await user.click(screen.getByRole('button', { name: 'Show password' }));

    expect(field.type).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeInTheDocument();
  });

  it('disables the field and skips the reveal button when not a password', () => {
    renderInput({ disabled: true });

    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
