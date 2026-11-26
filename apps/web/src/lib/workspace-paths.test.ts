import { describe, expect, it } from 'vitest';
import {
  asWorkspaceSlug,
  pathInWorkspace,
  withWorkspaceSlug,
  workspacePath,
  workspaceSlugFromPath,
} from './workspace-paths';

describe('workspace paths', () => {
  it('builds paths under /w/<slug>', () => {
    expect(workspacePath(asWorkspaceSlug('acme'))).toBe('/w/acme');
    expect(workspacePath(asWorkspaceSlug('acme'), '/')).toBe('/w/acme');
    expect(workspacePath(asWorkspaceSlug('acme'), '/p/PAY?view=board')).toBe('/w/acme/p/PAY?view=board');
    expect(workspacePath(asWorkspaceSlug('acme'), 'settings/members')).toBe('/w/acme/settings/members');
  });

  it('reads the slug and the path inside the workspace', () => {
    expect(workspaceSlugFromPath('/w/globex/p/PAY/PAY-1')).toBe('globex');
    expect(workspaceSlugFromPath('/w/globex')).toBe('globex');
    expect(workspaceSlugFromPath('/p/PAY')).toBeUndefined();
    expect(workspaceSlugFromPath('/welcome')).toBeUndefined();
    expect(pathInWorkspace('/w/globex/p/PAY/PAY-1')).toBe('/p/PAY/PAY-1');
    expect(pathInWorkspace('/w/globex')).toBe('/');
    expect(pathInWorkspace('/p/PAY')).toBe('/p/PAY');
  });

  it('moves a URL from an old slug to the current one, keeping the rest', () => {
    expect(withWorkspaceSlug('/w/old-name/p/PAY/PAY-1?tab=activity#c-12', 'acme')).toBe(
      '/w/acme/p/PAY/PAY-1?tab=activity#c-12',
    );
    expect(withWorkspaceSlug('/w/old-name', 'acme')).toBe('/w/acme');
    expect(withWorkspaceSlug('/w/old-name?x=1', 'acme')).toBe('/w/acme?x=1');
  });
});
