import { renderHook, waitFor } from '@testing-library/react';
import { apiJson } from '@shared/utils/api';
import { useUserGroupsData } from './useUserGroupsData';
import { useUsersData } from './useUsersData';

vi.mock('@shared/utils/api', () => ({
  apiJson: vi.fn(),
}));

it('loads every configured user group', async () => {
  vi.mocked(apiJson).mockResolvedValue({
    groups: [
      { id: 'guest', label: 'Guest' },
      { id: 'operator', label: 'Operators' },
      { id: 'engineer', label: 'Engineers' },
    ],
    users: [{ id: 1, username: 'operator', groups: ['operator'] }],
  });

  const { result } = renderHook(() => ({
    groups: useUserGroupsData(),
    users: useUsersData(),
  }));

  await waitFor(() => {
    expect(result.current.groups).toEqual([
      { id: 'guest', label: 'Guest' },
      { id: 'operator', label: 'Operators' },
      { id: 'engineer', label: 'Engineers' },
    ]);
  });
  expect(result.current.users).toEqual([{ id: 1, username: 'operator', groups: ['operator'] }]);
  expect(apiJson).toHaveBeenCalledWith('/api/users');
  expect(apiJson).toHaveBeenCalledTimes(1);
});
