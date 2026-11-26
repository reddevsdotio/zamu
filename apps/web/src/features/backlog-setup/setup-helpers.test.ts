import type { BacklogMappingsView } from '@zamu/contracts';
import { describe, expect, it } from 'vitest';
import { asWorkspaceSlug } from '~/lib/workspace-paths';
import { connectionReads, hostName, pickConnection } from './connections';
import { applyManualPicks, mappingValueCount, setAssignee, setStatus, toMappings } from './mappings';
import { backlogWebhookHref, projectSettingsHref } from './paths';
import { parseSetupSearch } from './search';

describe('parseSetupSearch', () => {
  it('reads the links project settings uses', () => {
    expect(parseSetupSearch({ mode: 'mirror' })).toEqual({ mode: 'mirror' });
    expect(parseSetupSearch({ mode: 'import' })).toEqual({ mode: 'import' });
    // TanStack parses ?edit=1 to the number 1; a typed link sends true.
    expect(parseSetupSearch({ step: 'mappings', edit: 1 })).toEqual({ step: 'mappings', edit: true });
    expect(parseSetupSearch({ step: 'mappings', edit: '1' })).toEqual({ step: 'mappings', edit: true });
    expect(parseSetupSearch({ step: 'mappings', edit: true })).toEqual({ step: 'mappings', edit: true });
  });

  it('keeps the setup state and drops anything unknown', () => {
    expect(
      parseSetupSearch({
        mode: 'sync',
        step: 'nowhere',
        edit: 0,
        connection: ' c-1 ',
        folder: 'docs/backlog',
      }),
    ).toEqual({ connection: 'c-1', folder: 'docs/backlog' });
    // Mode is the default step, so it is left out of the URL.
    expect(parseSetupSearch({ step: 'mode' })).toEqual({});
    expect(parseSetupSearch({ step: 'read', connection: 'x'.repeat(65) })).toEqual({ step: 'read' });
  });
});

describe('connections by host', () => {
  const connections = [
    { id: 'gh', host: 'github.com', status: 'working' as const },
    { id: 'fj-old', host: 'localhost:3300', status: 'rejected' as const },
    { id: 'fj', host: 'LOCALHOST:3300', status: 'working' as const },
    { id: 'v6', host: '[::1]:8080', status: 'working' as const },
  ];

  it('compares host names without ports', () => {
    expect(hostName('localhost:3300')).toBe('localhost');
    expect(hostName('Git.Example.com')).toBe('git.example.com');
    expect(hostName('[::1]:8080')).toBe('::1');
    expect(connectionReads({ host: 'gitlab.example.com:8443' }, 'gitlab.example.com')).toBe(true);
    expect(connectionReads({ host: 'gitlab.com' }, 'github.com')).toBe(false);
  });

  it('prefers a working connection on the repository host', () => {
    expect(pickConnection(connections, 'http://localhost:3300/zamu-admin/payments.git')?.id).toBe('fj');
    expect(pickConnection(connections, 'git@github.com:ana/notes.git')?.id).toBe('gh');
    expect(pickConnection(connections, 'https://gitlab.com/team/app')).toBeNull();
    expect(pickConnection(connections, 'not a url')).toBeNull();
    expect(pickConnection(connections, null)).toBeNull();
  });
});

const VIEW: BacklogMappingsView = {
  status: [
    { from: 'To Do', to: 'todo', how: 'name', count: 24 },
    { from: 'Blocked', to: 'todo', how: 'fallback', count: 2 },
  ],
  priority: [{ from: 'high', to: 'high', how: 'name', count: 41 }],
  assignee: [
    {
      from: '@claude',
      userId: 'u-claude',
      how: 'name',
      count: 219,
      user: { id: 'u-claude', name: 'claude-dev', kind: 'agent' },
    },
    { from: '@francis', userId: null, how: 'fallback', count: 5, user: null },
  ],
};

describe('mappings', () => {
  it('drops counts and users for the server', () => {
    expect(toMappings(VIEW)).toEqual({
      status: [
        { from: 'To Do', to: 'todo', how: 'name' },
        { from: 'Blocked', to: 'todo', how: 'fallback' },
      ],
      priority: [{ from: 'high', to: 'high', how: 'name' }],
      assignee: [
        { from: '@claude', userId: 'u-claude', how: 'name' },
        { from: '@francis', userId: null, how: 'fallback' },
      ],
    });
    expect(mappingValueCount(VIEW)).toBe(5);
  });

  it('marks a pick by hand as manual', () => {
    const next = setStatus(VIEW, 'Blocked', 'in_progress');
    expect(next.status[1]).toEqual({ from: 'Blocked', to: 'in_progress', how: 'manual', count: 2 });
    expect(next.status[0]).toBe(VIEW.status[0]);
    const assigned = setAssignee(VIEW, '@francis', 'u-ana');
    expect(assigned.assignee[1]).toMatchObject({ userId: 'u-ana', how: 'manual' });
  });

  it('puts saved manual picks back on fresh detection, case-insensitively', () => {
    const saved = toMappings(setAssignee(setStatus(VIEW, 'Blocked', 'in_review'), '@francis', 'u-ana'));
    // A by-name row in the saved copy does not override detection.
    saved.status[0] = { from: 'to do', to: 'done', how: 'name' };
    saved.status[1] = { ...saved.status[1], from: 'BLOCKED' } as (typeof saved.status)[number];
    const restored = applyManualPicks(VIEW, saved);
    expect(restored.status.map((row) => [row.to, row.how])).toEqual([
      ['todo', 'name'],
      ['in_review', 'manual'],
    ]);
    expect(restored.assignee[1]).toMatchObject({ userId: 'u-ana', how: 'manual', count: 5 });
    expect(applyManualPicks(VIEW, null)).toBe(VIEW);
  });
});

describe('setup paths', () => {
  it('links to the project settings and the webhook dialog', () => {
    expect(projectSettingsHref(asWorkspaceSlug('acme'), 'PAY')).toBe('/w/acme/p/PAY/settings');
    expect(backlogWebhookHref(asWorkspaceSlug('acme'), 'PAY')).toBe(
      '/w/acme/p/PAY/settings/backlog?webhook=1',
    );
  });
});
