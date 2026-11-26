import { describe, expect, it } from 'vitest';
import { storageKeyPrefix, workspaceStorageKey } from './storage-keys';

describe('workspace storage keys', () => {
  it('put the workspace id after the name and version', () => {
    expect(workspaceStorageKey('view', 'ws-1', 'PAY')).toBe('zamu:view:v2:ws-1:PAY');
    expect(workspaceStorageKey('display', 'ws-1', 'u-1', 'PAY', 'board')).toBe(
      'zamu:display:v2:ws-1:u-1:PAY:board',
    );
    expect(workspaceStorageKey('task-nav', 'ws-1')).toBe('zamu:task-nav:v2:ws-1');
  });

  it('keep the same project apart in two workspaces', () => {
    expect(workspaceStorageKey('view', 'acme-id', 'PAY')).not.toBe(
      workspaceStorageKey('view', 'globex-id', 'PAY'),
    );
  });

  it('share a prefix per name, unlike the keys before 0.10', () => {
    expect(workspaceStorageKey('display', 'ws-1', 'u-1').startsWith(storageKeyPrefix('display'))).toBe(true);
    expect('zamu:display:v1:u-1:PAY:board'.startsWith(storageKeyPrefix('display'))).toBe(false);
  });
});
