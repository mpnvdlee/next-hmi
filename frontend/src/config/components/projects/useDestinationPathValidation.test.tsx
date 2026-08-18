import { act, renderHook } from '@testing-library/react';
import { useProjectsStore } from '@config/store/projectsStore';
import { useDestinationPathValidation } from './useDestinationPathValidation';

const originalValidate = useProjectsStore.getState().validatePath;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  useProjectsStore.setState({ validatePath: originalValidate });
  vi.useRealTimers();
});

it('debounces validation and reports an available destination', async () => {
  const validatePath = vi.fn().mockResolvedValue({ ok: true, exists: false });
  useProjectsStore.setState({ validatePath });

  const { result } = renderHook(() => useDestinationPathValidation('/projects/new'));
  expect(result.current).toBeNull();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });

  expect(validatePath).toHaveBeenCalledOnce();
  expect(validatePath).toHaveBeenCalledWith('/projects/new');
  expect(result.current).toEqual({ ok: true, message: 'Path will be created.' });
});

it('supports caller-specific backend reason text and cancels stale paths', async () => {
  const validatePath = vi.fn().mockResolvedValue({ ok: false, reason: 'parent-missing' });
  useProjectsStore.setState({ validatePath });

  const { result, rerender } = renderHook(
    ({ path }) =>
      useDestinationPathValidation(path, {
        formatReason: (reason) => `reason:${reason}`,
      }),
    { initialProps: { path: '/old' } },
  );
  rerender({ path: '/new' });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });

  expect(validatePath).toHaveBeenCalledOnce();
  expect(validatePath).toHaveBeenCalledWith('/new');
  expect(result.current).toEqual({ ok: false, message: 'reason:parent-missing' });
});

it('rejects an existing non-empty destination', async () => {
  useProjectsStore.setState({
    validatePath: vi.fn().mockResolvedValue({ ok: true, exists: true, isEmpty: false }),
  });

  const { result } = renderHook(() => useDestinationPathValidation('/projects/existing'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });

  expect(result.current).toEqual({
    ok: false,
    message: 'Destination directory is not empty.',
  });
});

it('rejects an existing empty destination when the caller requires an absent path', async () => {
  useProjectsStore.setState({
    validatePath: vi.fn().mockResolvedValue({ ok: true, exists: true, isEmpty: true }),
  });

  const { result } = renderHook(() =>
    useDestinationPathValidation('/projects/existing-empty', { requireAbsent: true }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });

  expect(result.current).toEqual({
    ok: false,
    message: 'Destination path already exists.',
  });
});
