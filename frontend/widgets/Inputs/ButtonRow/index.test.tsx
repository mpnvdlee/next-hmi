import '../../testSdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useVariableStore } from '@hmi/store/variableStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useComponentPropStore } from '@hmi/store/widgetPropStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { __resetForTests } from '@hmi/utils/actionDispatcher';
import ButtonRow from './index';

vi.mock('@hmi/hooks/useWebSocket', () => ({
  sendWsMessage: vi.fn(),
}));

const VAR_KEY = 'PLC:Line/Mode';
const BINDING = { $var: { path: VAR_KEY } };
const OPTIONS = [
  { label: 'Manual', value: 1 },
  { label: 'Auto', value: 2 },
];

function sentFrame(): Record<string, unknown> {
  return vi.mocked(sendWsMessage).mock.calls[0][0] as Record<string, unknown>;
}

function renderRow(properties: Record<string, unknown>, id = 'modes') {
  return render(
    <MemoryRouter>
      <ButtonRow id={id} properties={properties} />
    </MemoryRouter>,
  );
}

describe('ButtonRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
    useVariableStore.setState({ values: {}, varMeta: {} });
    useHmiStore.setState({ openDialogs: [], pendingToasts: [] });
    useComponentPropStore.setState({ props: {} });
  });

  afterEach(() => {
    __resetForTests();
  });

  it('renders with no properties at all', () => {
    const { container } = renderRow({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-component');
    expect(el.className).toContain('hmi-button-row');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('writes the chosen option with a correlating requestId', async () => {
    const user = userEvent.setup();
    renderRow({ options: OPTIONS, variable: BINDING });

    await user.click(screen.getByRole('button', { name: 'Auto' }));

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'write_field',
      requestId: expect.any(String),
      scope: 'runtime:preview',
      datasource: 'PLC',
      path: 'Line/Mode',
      value: 2,
    });
    expect(sentFrame().requestId).toBeTruthy();
  });

  it('marks the option matching the bound value as active', () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 1 } });
    renderRow({ options: OPTIONS, variable: BINDING });

    expect(screen.getByRole('button', { name: 'Manual' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('publishes the bound selection as its `selectedValue` export', () => {
    useVariableStore.setState({ values: { [VAR_KEY]: 2 } });
    renderRow({ options: OPTIONS, variable: BINDING });

    expect(useComponentPropStore.getState().props.modes.selectedValue).toBe('2');
  });

  it('tracks and publishes the selection locally when nothing is bound', async () => {
    const user = userEvent.setup();
    renderRow({ options: OPTIONS });

    await user.click(screen.getByRole('button', { name: 'Auto' }));

    expect(sendWsMessage).not.toHaveBeenCalled();
    expect(useComponentPropStore.getState().props.modes.selectedValue).toBe('2');
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('runs the onChange actions for the chosen option', async () => {
    const user = userEvent.setup();
    renderRow({
      options: OPTIONS,
      onChange: { onChange: [{ type: 'openDialog', dialogId: 'confirm' }] },
    });

    await user.click(screen.getByRole('button', { name: 'Manual' }));

    expect(useHmiStore.getState().openDialogs.map((d) => d.id)).toContain('confirm');
  });

  it('ignores clicks while disabled', async () => {
    const user = userEvent.setup();
    renderRow({ options: OPTIONS, variable: BINDING, disabled: true });

    await user.click(screen.getByRole('button', { name: 'Auto' }));

    expect(sendWsMessage).not.toHaveBeenCalled();
  });
});
