import { describe, expect, it } from 'vitest';
import { foldedColumnsKey } from './collapsed';

describe('folded columns key', () => {
  it('keys a board by workspace, person, project and column field', () => {
    expect(foldedColumnsKey('acme-id', 'u-1', 'PAY', 'status')).toBe(
      'zamu:board-columns:v2:acme-id:u-1:PAY:status',
    );
    expect(foldedColumnsKey('acme-id', null, 'PAY', 'status')).toBe(
      'zamu:board-columns:v2:acme-id:~:PAY:status',
    );
  });

  it('keeps the same project in two workspaces apart', () => {
    expect(foldedColumnsKey('acme-id', 'u-1', 'PAY', 'label')).not.toBe(
      foldedColumnsKey('globex-id', 'u-1', 'PAY', 'label'),
    );
  });
});
