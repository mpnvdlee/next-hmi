import { publishConfigChanged, subscribeConfigChanged } from './configChangedBus';

const EVENT = {
  artifact_type: 'page' as const,
  artifact_ids: ['page-1'],
  source: 'mcp' as const,
  summary: 'Updated page-1',
};

describe('configChangedBus', () => {
  const unsubscribers: Array<() => void> = [];

  afterEach(() => {
    unsubscribers.splice(0).forEach((fn) => fn());
  });

  it('delivers a published event to every subscribed listener', () => {
    const a = vi.fn();
    const b = vi.fn();
    unsubscribers.push(subscribeConfigChanged(a), subscribeConfigChanged(b));

    publishConfigChanged(EVENT);

    expect(a).toHaveBeenCalledWith(EVENT);
    expect(b).toHaveBeenCalledWith(EVENT);
  });

  it('stops delivering to a listener after it unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeConfigChanged(listener);

    unsubscribe();
    publishConfigChanged(EVENT);

    expect(listener).not.toHaveBeenCalled();
  });

  it('does not let one throwing listener prevent others from being called', () => {
    const throwing = vi.fn(() => {
      throw new Error('boom');
    });
    const after = vi.fn();
    unsubscribers.push(subscribeConfigChanged(throwing), subscribeConfigChanged(after));

    expect(() => publishConfigChanged(EVENT)).not.toThrow();
    expect(after).toHaveBeenCalledWith(EVENT);
  });
});
