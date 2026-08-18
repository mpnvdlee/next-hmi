import { publishWidgetUpdated, subscribeWidgetUpdated } from './widgetUpdatedBus';

const EVENT = {
  key: 'Inputs/Display',
  name: 'Display',
  ts: '2024-01-01T00:00:00Z',
  schema_ok: true,
};

describe('widgetUpdatedBus', () => {
  const unsubscribers: Array<() => void> = [];

  afterEach(() => {
    unsubscribers.splice(0).forEach((fn) => fn());
    vi.restoreAllMocks();
  });

  it('delivers a published event to every subscribed listener', () => {
    const a = vi.fn();
    const b = vi.fn();
    unsubscribers.push(subscribeWidgetUpdated(a), subscribeWidgetUpdated(b));

    publishWidgetUpdated(EVENT);

    expect(a).toHaveBeenCalledWith(EVENT);
    expect(b).toHaveBeenCalledWith(EVENT);
  });

  it('stops delivering to a listener after it unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWidgetUpdated(listener);

    unsubscribe();
    publishWidgetUpdated(EVENT);

    expect(listener).not.toHaveBeenCalled();
  });

  it('does not let one throwing listener prevent others from being called', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing = vi.fn(() => {
      throw new Error('boom');
    });
    const after = vi.fn();
    unsubscribers.push(subscribeWidgetUpdated(throwing), subscribeWidgetUpdated(after));

    expect(() => publishWidgetUpdated(EVENT)).not.toThrow();
    expect(after).toHaveBeenCalledWith(EVENT);
  });

  it('logs the throwing listener error instead of silently swallowing it', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('boom');
    unsubscribers.push(
      subscribeWidgetUpdated(() => {
        throw err;
      }),
    );

    publishWidgetUpdated(EVENT);

    expect(errorSpy).toHaveBeenCalledWith('widgetUpdated listener threw', err);
  });
});
