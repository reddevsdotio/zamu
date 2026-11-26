import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetMappings, loadSavedMappings, mappingsStorageKey, saveMappings } from './mapping-memory';

// Setup picks are kept per workspace and project: Acme's PAY and Globex's PAY are set up apart.

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

const MAPPINGS = { status: [], priority: [], assignee: [] };

beforeEach(() => vi.stubGlobal('window', { sessionStorage: memoryStorage() }));
afterEach(() => vi.unstubAllGlobals());

describe('setup mapping memory', () => {
  it('keys the picks by workspace id and project', () => {
    expect(mappingsStorageKey('acme-id', 'PAY')).toBe('zamu:backlog-mappings:v2:acme-id:PAY');
  });

  it('keeps two workspaces with the same project key apart', () => {
    saveMappings('acme-id', 'PAY', MAPPINGS);
    expect(loadSavedMappings('acme-id', 'PAY')).toEqual(MAPPINGS);
    expect(loadSavedMappings('globex-id', 'PAY')).toBeNull();
    forgetMappings('acme-id', 'PAY');
    expect(loadSavedMappings('acme-id', 'PAY')).toBeNull();
  });

  it('ignores picks stored before 0.10', () => {
    window.sessionStorage.setItem('zamu.backlog-setup.mappings.PAY', JSON.stringify(MAPPINGS));
    expect(loadSavedMappings('acme-id', 'PAY')).toBeNull();
  });
});
