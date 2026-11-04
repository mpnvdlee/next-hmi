import { afterEach, expect, it } from 'vitest';
import { identityRequest, saveSessionToken } from './runtimeSession';

afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

it('sends the ?panel= name with request_identity and keeps it after navigation drops the query', () => {
  window.history.replaceState(null, '', '/?panel=line-a-1');
  saveSessionToken('tok');
  expect(identityRequest('runtime:x')).toEqual({
    type: 'request_identity',
    scope: 'runtime:x',
    sessionToken: 'tok',
    panel: 'line-a-1',
  });

  window.history.replaceState(null, '', '/pages/other');
  expect(identityRequest('runtime:x').panel).toBe('line-a-1');
});

it('leaves a tab without the parameter unnamed', () => {
  expect(identityRequest('runtime:x').panel).toBeUndefined();
});
