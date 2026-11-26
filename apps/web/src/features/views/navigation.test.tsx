import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  readTaskNavigation,
  rememberTaskNavigation,
  taskNavigationFor,
  taskNavStorageKey,
  useTaskNavigation,
} from './navigation';

/** The workspace the lists below belong to. */
const WS = 'acme-id';

function Header({ taskKey }: { taskKey: string }) {
  const nav = useTaskNavigation(WS, taskKey);
  return (
    <output data-testid="nav">
      {nav.label ?? 'none'}|{nav.prev ?? '-'}|{nav.next ?? '-'}|{nav.returnTo ?? '-'}
    </output>
  );
}

beforeEach(() => sessionStorage.clear());

describe('navigation memory', () => {
  it('keeps the view’s keys in session storage and finds the task in them', () => {
    rememberTaskNavigation(WS, {
      keys: ['PAY-1', 'PAY-7', 'PAY-3'],
      from: 'List',
      returnTo: '/p/PAY?status=todo',
    });
    expect(JSON.parse(sessionStorage.getItem(taskNavStorageKey(WS)) ?? 'null')).toEqual({
      keys: ['PAY-1', 'PAY-7', 'PAY-3'],
      from: 'List',
      returnTo: '/p/PAY?status=todo',
    });
    render(<Header taskKey="PAY-7" />);
    expect(screen.getByTestId('nav')).toHaveTextContent('2 of 3 in List|PAY-1|PAY-3|/p/PAY?status=todo');
  });

  it('follows a new list and has no position for tasks outside it', () => {
    rememberTaskNavigation(WS, { keys: ['PAY-1', 'PAY-7'], from: 'List' });
    const { rerender } = render(<Header taskKey="PAY-1" />);
    expect(screen.getByTestId('nav')).toHaveTextContent('1 of 2 in List|-|PAY-7|-');
    act(() => rememberTaskNavigation(WS, { keys: ['HBR-4', 'PAY-1', 'PAY-9'], from: 'Home' }));
    expect(screen.getByTestId('nav')).toHaveTextContent('2 of 3 in Home|HBR-4|PAY-9|-');
    rerender(<Header taskKey="PAY-42" />);
    expect(screen.getByTestId('nav')).toHaveTextContent('none|-|-|-');
  });

  it('keeps long lists centred on the opened task', () => {
    const keys = Array.from({ length: 5000 }, (_, index) => `PAY-${index + 1}`);
    rememberTaskNavigation(WS, { keys, from: 'Board' }, 'PAY-4000');
    const list = readTaskNavigation(WS);
    expect(list?.keys).toHaveLength(2000);
    expect(taskNavigationFor(list, 'PAY-4000').next).toBe('PAY-4001');
  });

  it('keeps one list per workspace, and ignores the list stored before 0.10', () => {
    expect(taskNavStorageKey(WS)).toBe('zamu:task-nav:v2:acme-id');
    rememberTaskNavigation(WS, { keys: ['PAY-1', 'PAY-2'], from: 'List' });
    expect(readTaskNavigation('globex-id')).toBeNull();
    sessionStorage.setItem('zamu:task-nav:v1', JSON.stringify({ keys: ['PAY-9'], from: 'Board' }));
    expect(readTaskNavigation('globex-id')).toBeNull();
    expect(readTaskNavigation(WS)?.keys).toEqual(['PAY-1', 'PAY-2']);
  });

  it('ignores unreadable storage', () => {
    sessionStorage.setItem(taskNavStorageKey(WS), '{not json');
    expect(readTaskNavigation(WS)).toBeNull();
    expect(taskNavigationFor(null, 'PAY-1')).toMatchObject({ position: null, label: null });
  });
});
