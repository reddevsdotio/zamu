import { describe, expect, it } from 'vitest';
import { asWorkspaceSlug } from '~/lib/workspace-paths';
import {
  homeHref,
  isHomePath,
  isSettingsPath,
  projectHref,
  projectKeyFromPath,
  projectPageFromLocation,
  projectPageHref,
  projectViewOfHref,
  taskHref,
  taskKeyFromPath,
} from './paths';

describe('workspace pages', () => {
  it('links Home and tells it apart', () => {
    expect(homeHref(asWorkspaceSlug('acme'))).toBe('/w/acme');
    expect(isHomePath('/w/acme')).toBe(true);
    expect(isHomePath('/w/acme/')).toBe(true);
    expect(isHomePath('/w/acme/p/PAY')).toBe(false);
    expect(isSettingsPath('/w/acme/settings/members')).toBe(true);
    expect(isSettingsPath('/w/acme/p/PAY/settings')).toBe(false);
  });

  it('reads the project and view of a list or board link', () => {
    expect(projectViewOfHref('/w/acme/p/PAY')).toEqual({ projectKey: 'PAY', view: 'list' });
    expect(projectViewOfHref('/w/acme/p/PAY?view=board')).toEqual({ projectKey: 'PAY', view: 'board' });
    expect(projectViewOfHref('/w/acme/p/PAY/cycles')).toBeUndefined();
  });
});

describe('projectKeyFromPath', () => {
  it('reads the key from task list and task URLs', () => {
    expect(projectKeyFromPath('/p/PAY')).toBe('PAY');
    expect(projectKeyFromPath('/p/pay/PAY-142')).toBe('PAY');
    expect(projectKeyFromPath('/projects')).toBeUndefined();
    expect(projectKeyFromPath('/settings/members')).toBeUndefined();
    expect(projectKeyFromPath('/p/%E0%A4%A')).toBeUndefined();
  });

  it('reads the same inside a workspace', () => {
    expect(projectKeyFromPath('/w/acme/p/pay/PAY-142')).toBe('PAY');
    expect(projectKeyFromPath('/w/acme/settings/members')).toBeUndefined();
    expect(projectKeyFromPath('/w/acme')).toBeUndefined();
    expect(taskKeyFromPath('/w/globex/p/PAY/pay-1')).toBe('PAY-1');
    expect(projectPageFromLocation('/w/acme/p/PAY/cycles/12', {})).toBe('cycles');
  });

  it('builds the task list URL', () => {
    expect(projectHref(asWorkspaceSlug('acme'), 'PAY')).toBe('/w/acme/p/PAY');
  });
});

describe('project pages', () => {
  it('links every page the sidebar lists', () => {
    expect(projectPageHref(asWorkspaceSlug('acme'), 'PAY', 'list')).toBe('/w/acme/p/PAY');
    expect(projectPageHref(asWorkspaceSlug('acme'), 'PAY', 'board')).toBe('/w/acme/p/PAY?view=board');
    expect(projectPageHref(asWorkspaceSlug('acme'), 'PAY', 'milestones')).toBe('/w/acme/p/PAY/milestones');
    expect(projectPageHref(asWorkspaceSlug('acme'), 'PAY', 'cycles')).toBe('/w/acme/p/PAY/cycles');
    expect(projectPageHref(asWorkspaceSlug('acme'), 'PAY', 'settings')).toBe('/w/acme/p/PAY/settings');
  });

  it('knows which page the URL shows', () => {
    expect(projectPageFromLocation('/p/PAY', {})).toBe('list');
    expect(projectPageFromLocation('/p/PAY', { view: 'board' })).toBe('board');
    expect(projectPageFromLocation('/p/PAY/milestones/abc', {})).toBe('milestones');
    expect(projectPageFromLocation('/p/PAY/cycles/12', {})).toBe('cycles');
    expect(projectPageFromLocation('/p/PAY/settings/backlog', {})).toBe('settings');
    expect(projectPageFromLocation('/p/PAY/PAY-142', {})).toBeUndefined();
    expect(projectPageFromLocation('/', {})).toBeUndefined();
  });
});

describe('task URLs', () => {
  it('reads the task key of the task view only', () => {
    expect(taskKeyFromPath('/p/PAY/PAY-142')).toBe('PAY-142');
    expect(taskKeyFromPath('/p/PAY/pay-786.1')).toBe('PAY-786.1');
    expect(taskKeyFromPath('/p/PAY/milestones')).toBeUndefined();
    expect(taskKeyFromPath('/p/PAY/settings')).toBeUndefined();
    expect(taskKeyFromPath('/p/PAY')).toBeUndefined();
    expect(taskKeyFromPath('/p/PAY/milestones/abc')).toBeUndefined();
  });

  it('builds the task view URL from the key', () => {
    expect(taskHref(asWorkspaceSlug('acme'), 'PAY-142')).toBe('/w/acme/p/PAY/PAY-142');
    expect(taskHref(asWorkspaceSlug('acme'), 'PAY-786.1')).toBe('/w/acme/p/PAY/PAY-786.1');
  });
});
