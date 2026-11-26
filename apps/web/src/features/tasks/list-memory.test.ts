import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberedView, rememberProjectView, viewStorageKey } from './list-memory';

// The List / Board choice is kept per workspace and project: Acme's PAY and Globex's PAY are apart.

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

beforeEach(() => vi.stubGlobal('window', { localStorage: memoryStorage() }));
afterEach(() => vi.unstubAllGlobals());

describe('view memory', () => {
  it('keys the choice by workspace id and project', () => {
    expect(viewStorageKey('acme-id', 'PAY')).toBe('zamu:view:v2:acme-id:PAY');
  });

  it('keeps two workspaces with the same project key apart', () => {
    rememberProjectView('acme-id', 'PAY', 'board');
    expect(rememberedView('acme-id', 'PAY')).toBe('board');
    expect(rememberedView('globex-id', 'PAY')).toBeNull();
  });

  it('ignores choices stored before 0.10', () => {
    window.localStorage.setItem('zamu:view:PAY', 'board');
    expect(rememberedView('acme-id', 'PAY')).toBeNull();
  });
});
