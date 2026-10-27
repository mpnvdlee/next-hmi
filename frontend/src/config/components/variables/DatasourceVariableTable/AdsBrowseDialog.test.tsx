import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeNode } from '@shared/types/datasource';
import { apiJson } from '@shared/utils/api';
import AdsBrowseDialog from './AdsBrowseDialog';
import { mergeBrowseSelection } from './browseMerge';

vi.mock('@shared/utils/api', () => ({ apiJson: vi.fn() }));

const mockedApiJson = vi.mocked(apiJson);

const SAVED: TreeNode[] = [
  {
    kind: 'folder',
    name: 'MAIN',
    node_id: 'MAIN',
    children: [
      {
        kind: 'variable',
        node_id: 'MAIN.fSpeed',
        display_name: 'fSpeed',
        data_type: 'Double',
        enabled: true,
      },
    ],
  },
];

// One level each, as GET /browse answers in browse_mode "lazy".
const LEVELS: Record<string, object> = {
  '': {
    node_id: '',
    display_name: 'Plc30 App',
    data_type: null,
    show_root: false,
    browse_mode: 'lazy',
    children: [
      { node_id: 'MAIN', display_name: 'MAIN', data_type: null, children: [], has_children: true },
      { node_id: 'GVL', display_name: 'GVL', data_type: null, children: [], has_children: true },
    ],
  },
  MAIN: {
    node_id: 'MAIN',
    display_name: 'MAIN',
    data_type: null,
    show_root: true,
    browse_mode: 'lazy',
    children: [
      {
        node_id: 'MAIN.fSpeed',
        display_name: 'fSpeed',
        data_type: 'Double',
        children: [],
        writable: true,
      },
      {
        node_id: 'MAIN.stMotor',
        display_name: 'stMotor',
        data_type: 'struct',
        children: [],
        writable: false,
        has_children: true,
      },
    ],
  },
  'MAIN.stMotor': {
    node_id: 'MAIN.stMotor',
    display_name: 'MAIN.stMotor',
    data_type: null,
    show_root: true,
    browse_mode: 'lazy',
    children: [
      {
        node_id: 'MAIN.stMotor.bRunning',
        display_name: 'bRunning',
        data_type: 'Boolean',
        children: [],
        writable: true,
      },
    ],
  },
};

function lazyPlc() {
  mockedApiJson.mockImplementation(async (url: string) => {
    const nodeId = new URL(url, 'http://x').searchParams.get('node_id') ?? '';
    return LEVELS[nodeId];
  });
}

function expand(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `Expand ${name}` }));
}

describe('AdsBrowseDialog', () => {
  beforeEach(() => {
    mockedApiJson.mockReset();
  });

  it('fetches one level per expanded node, once, and adds what is ticked', async () => {
    lazyPlc();
    const onImport = vi.fn();
    render(
      <AdsBrowseDialog dsName="plc" savedTree={SAVED} onImport={onImport} onClose={vi.fn()} />,
    );

    await screen.findByText('GVL');
    expect(mockedApiJson).toHaveBeenCalledTimes(1);
    expect(mockedApiJson.mock.calls[0][0]).toBe('/api/datasources/plc/browse');

    expand('MAIN');
    await screen.findByText('fSpeed');
    expect(mockedApiJson.mock.calls[1][0]).toBe('/api/datasources/plc/browse?node_id=MAIN');

    // Saved already: shown as added and cannot be ticked.
    const fSpeed = screen.getByText('fSpeed').closest('label')!;
    expect(within(fSpeed).getByText('added')).toBeTruthy();
    expect((within(fSpeed).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);

    expand('stMotor');
    fireEvent.click(await screen.findByText('bRunning'));
    expect(mockedApiJson.mock.calls[2][0]).toBe('/api/datasources/plc/browse?node_id=MAIN.stMotor');

    // Collapsing and opening again reuses the level already loaded.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse MAIN' }));
    expand('MAIN');
    expect(mockedApiJson).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole('button', { name: 'Add 1 variable' }));
    expect(onImport).toHaveBeenCalledTimes(1);
    const [nodes, selected] = onImport.mock.calls[0];
    expect([...selected]).toEqual(['MAIN.stMotor.bRunning']);

    const merged = mergeBrowseSelection(SAVED, nodes, selected);
    expect(merged[0]).toMatchObject({
      name: 'MAIN',
      children: [
        { node_id: 'MAIN.fSpeed', enabled: true },
        {
          kind: 'folder',
          name: 'stMotor',
          node_id: 'MAIN.stMotor',
          children: [{ node_id: 'MAIN.stMotor.bRunning', enabled: false }],
        },
      ],
    });
  });

  it('says plainly when a marked browse finds nothing', async () => {
    mockedApiJson.mockResolvedValue({
      node_id: '',
      display_name: 'Plc30 App',
      data_type: null,
      browse_mode: 'marked',
      children: [],
    });
    render(
      <AdsBrowseDialog
        dsName="plc"
        savedTree={[]}
        attributes="HMI_VISIBLE, OPC.UA.DA"
        onImport={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const message = await screen.findByRole('status');
    expect(message.textContent).toContain(
      "Nothing on the PLC carries {attribute 'HMI_VISIBLE' := '1'}",
    );
    expect(message.textContent).toContain('Lazy (one level)');
    expect(screen.getByRole('button', { name: 'Add variables' })).toBeDisabled();
  });

  it('opens a marked tree whole and selects every new variable at once', async () => {
    mockedApiJson.mockResolvedValue({
      node_id: '',
      display_name: 'Plc30 App',
      data_type: null,
      browse_mode: 'marked',
      children: [
        {
          node_id: 'MAIN',
          display_name: 'MAIN',
          data_type: null,
          children: [
            { node_id: 'MAIN.fSpeed', display_name: 'fSpeed', data_type: 'Double', children: [] },
            { node_id: 'MAIN.nCount', display_name: 'nCount', data_type: 'Int16', children: [] },
          ],
        },
        {
          node_id: 'GVL',
          display_name: 'GVL',
          data_type: null,
          children: [
            {
              node_id: 'GVL.sVersion',
              display_name: 'sVersion',
              data_type: 'String',
              children: [],
            },
          ],
        },
      ],
    });
    render(<AdsBrowseDialog dsName="plc" savedTree={SAVED} onImport={vi.fn()} onClose={vi.fn()} />);

    await screen.findByText('sVersion');
    expect(screen.getByText('nCount')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select all new' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add 2 variables' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select new variables in MAIN' }));
    expect(screen.getByRole('button', { name: 'Add 1 variable' })).toBeTruthy();
  });

  it('shows why the browse failed', async () => {
    mockedApiJson.mockRejectedValue(new Error("Datasource 'plc' is not connected"));
    render(<AdsBrowseDialog dsName="plc" savedTree={[]} onImport={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText("Datasource 'plc' is not connected")).toBeTruthy();
  });

  it('says nothing is marked below a browse root too', async () => {
    mockedApiJson.mockResolvedValue({
      node_id: 'GVL_HMI',
      display_name: 'GVL_HMI',
      data_type: null,
      show_root: true,
      browse_mode: 'marked',
      children: [],
    });
    render(<AdsBrowseDialog dsName="plc" savedTree={[]} onImport={vi.fn()} onClose={vi.fn()} />);
    expect((await screen.findByRole('status')).textContent).toContain(
      "Nothing on the PLC carries {attribute 'OPC.UA.DA' := '1'}",
    );
  });

  it('says so when a marked browse finds only what is added already', async () => {
    mockedApiJson.mockResolvedValue({
      node_id: '',
      display_name: 'Plc30 App',
      data_type: null,
      browse_mode: 'marked',
      children: [
        {
          node_id: 'MAIN',
          display_name: 'MAIN',
          data_type: null,
          children: [{ node_id: 'main.fspeed', display_name: 'fSpeed', data_type: 'Double' }],
        },
      ],
    });
    render(<AdsBrowseDialog dsName="plc" savedTree={SAVED} onImport={vi.fn()} onClose={vi.fn()} />);
    expect((await screen.findByRole('status')).textContent).toBe(
      'Every variable this browse found is already in this datasource.',
    );
    // Matched whatever the case of the path.
    expect(within(screen.getByText('fSpeed').closest('label')!).getByText('added')).toBeTruthy();
  });

  it('opens only the browse root in lazy mode, and loads a folder below it on first click', async () => {
    mockedApiJson.mockImplementation(async (url: string) => {
      const nodeId = new URL(url, 'http://x').searchParams.get('node_id');
      if (nodeId === 'MAIN.stMotor') return LEVELS['MAIN.stMotor'];
      return { ...LEVELS.MAIN, show_root: true };
    });
    render(<AdsBrowseDialog dsName="plc" savedTree={[]} onImport={vi.fn()} onClose={vi.fn()} />);

    await screen.findByText('fSpeed');
    expect(screen.getByRole('button', { name: 'Collapse MAIN' })).toBeTruthy();
    // Not loaded yet, so not open: the first click loads it.
    fireEvent.click(screen.getByRole('button', { name: 'Expand stMotor' }));
    expect(await screen.findByText('bRunning')).toBeTruthy();
    expect(mockedApiJson).toHaveBeenCalledTimes(2);
  });
});
