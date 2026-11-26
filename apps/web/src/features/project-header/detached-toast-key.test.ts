import { describe, expect, it } from 'vitest';
import { detachedToastKey } from './MirrorNotices';

describe('detached toast key', () => {
  it('remembers the toast per workspace, project and detach', () => {
    expect(detachedToastKey('acme-id', 'PAY', '2026-11-20T10:00:00.000Z')).toBe(
      'zamu:detached-toast:v2:acme-id:PAY:2026-11-20T10:00:00.000Z',
    );
    expect(detachedToastKey('globex-id', 'PAY', '2026-11-20T10:00:00.000Z')).not.toBe(
      detachedToastKey('acme-id', 'PAY', '2026-11-20T10:00:00.000Z'),
    );
  });
});
