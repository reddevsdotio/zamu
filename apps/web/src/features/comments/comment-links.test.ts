import { describe, expect, it } from 'vitest';
import { asWorkspaceSlug } from '~/lib/workspace-paths';
import { inWorkspaceHref } from './CommentMarkdown';

// Links in comments to this instance's pre-0.10 URLs open them in the comment's workspace.

const ORIGIN = 'https://zamu.example.com';

describe('inWorkspaceHref', () => {
  it('moves an old task or project URL of this instance under the workspace', () => {
    expect(inWorkspaceHref(`${ORIGIN}/p/PAY/PAY-1?tab=activity#c-2`, ORIGIN, asWorkspaceSlug('globex'))).toBe(
      `${ORIGIN}/w/globex/p/PAY/PAY-1?tab=activity#c-2`,
    );
    expect(inWorkspaceHref(`${ORIGIN}/p/PAY`, ORIGIN, asWorkspaceSlug('acme'))).toBe(
      `${ORIGIN}/w/acme/p/PAY`,
    );
  });

  it('leaves other links alone', () => {
    expect(inWorkspaceHref('https://example.org/p/PAY/PAY-1', ORIGIN, asWorkspaceSlug('acme'))).toBe(
      'https://example.org/p/PAY/PAY-1',
    );
    expect(inWorkspaceHref(`${ORIGIN}/w/acme/p/PAY/PAY-1`, ORIGIN, asWorkspaceSlug('globex'))).toBe(
      `${ORIGIN}/w/acme/p/PAY/PAY-1`,
    );
    expect(inWorkspaceHref(`${ORIGIN}/p/PAY/PAY-1`, null, asWorkspaceSlug('acme'))).toBe(
      `${ORIGIN}/p/PAY/PAY-1`,
    );
    expect(inWorkspaceHref(`${ORIGIN}/p/PAY/PAY-1`, ORIGIN, undefined)).toBe(`${ORIGIN}/p/PAY/PAY-1`);
  });
});
