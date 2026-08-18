import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SubscriptionsSection from './index';
import type { SubscriptionEntry } from '@config/store/adminViewStore';

function entry(overrides: Partial<SubscriptionEntry> = {}): SubscriptionEntry {
  return {
    priority_paths: [],
    priority_leaf_paths: [],
    connected: true,
    bg_enabled: false,
    ...overrides,
  };
}

function renderSection(props: Partial<React.ComponentProps<typeof SubscriptionsSection>> = {}) {
  return render(
    <SubscriptionsSection subscriptions={{}} alarmTriggers={{}} historianPaths={{}} {...props} />,
  );
}

describe('SubscriptionsSection', () => {
  it('reports no active datasources when the engine has none', () => {
    renderSection();

    expect(screen.getByText('No OPC-UA datasources active.')).toBeInTheDocument();
  });

  it('shows the connection and background-poll state per datasource', () => {
    renderSection({
      subscriptions: {
        plc: entry({ connected: false, bg_enabled: true, priority_paths: ['ns=2;s=Temp'] }),
      },
    });

    expect(screen.getByText('Disconnected')).toBeInTheDocument();
    expect(screen.getByText('BG On')).toBeInTheDocument();
  });

  it('unions page, alarm and historian paths into one deduplicated fast list', () => {
    renderSection({
      subscriptions: { plc: entry({ priority_paths: ['B', 'A'] }) },
      alarmTriggers: { plc: ['A', 'C'] },
      historianPaths: { plc: ['D'] },
    });

    expect(screen.getByText('4 fast')).toBeInTheDocument();
    for (const path of ['plc:A', 'plc:B', 'plc:C', 'plc:D']) {
      expect(screen.getByText(new RegExp(path.replace(':', ':')))).toBeInTheDocument();
    }
  });

  it('keeps alarm and historian paths visible while the datasource is disconnected', () => {
    renderSection({
      subscriptions: { plc: entry({ connected: false, priority_paths: [] }) },
      alarmTriggers: { plc: ['Alarm1'] },
      historianPaths: { plc: ['Hist1'] },
    });

    expect(screen.getByText('2 fast')).toBeInTheDocument();
    expect(screen.queryByText('No fast subscriptions')).toBeNull();
  });

  it('titles a path with every reason it is subscribed', () => {
    const { container } = renderSection({
      subscriptions: { plc: entry({ priority_paths: ['Shared', 'PageOnly'] }) },
      alarmTriggers: { plc: ['Shared'] },
      historianPaths: { plc: ['Shared'] },
    });

    const titles = [...container.querySelectorAll('.cfg-admin-subscription-card__path')].map((n) =>
      n.getAttribute('title'),
    );
    expect(titles).toContain('Alarm trigger · Historized');
    expect(titles).toContain(null);
  });

  it('says so when a connected datasource carries no fast paths at all', () => {
    renderSection({ subscriptions: { plc: entry() } });

    expect(screen.getByText('No fast subscriptions')).toBeInTheDocument();
  });

  it('hides expanded leaves behind a per-datasource toggle', async () => {
    renderSection({
      subscriptions: {
        plc: entry({ priority_paths: ['Struct'], priority_leaf_paths: ['Struct.a', 'Struct.b'] }),
      },
    });

    expect(screen.getByText('1 fast (2 expanded leaves)')).toBeInTheDocument();
    expect(screen.queryByText('plc:Struct.a')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Priority leaves \(2\)/ }));
    expect(screen.getByText('plc:Struct.a')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Priority leaves \(2\)/ }));
    expect(screen.queryByText('plc:Struct.a')).toBeNull();
  });

  it('toggles each datasource card independently', async () => {
    renderSection({
      subscriptions: {
        plcA: entry({ priority_leaf_paths: ['A.1'] }),
        plcB: entry({ priority_leaf_paths: ['B.1'] }),
      },
    });

    const toggles = screen.getAllByRole('button', { name: /Priority leaves/ });
    await userEvent.click(toggles[0]);

    expect(screen.getByText('plcA:A.1')).toBeInTheDocument();
    expect(screen.queryByText('plcB:B.1')).toBeNull();
  });
});
