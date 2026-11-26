import { describe, expect, it } from 'vitest';
import { loadJson } from '../test/replay';
import { createProvider } from './create';
import { type ProviderKind, REQUEST_ACTIONS, REQUEST_STATES, type WebhookVerification } from './types';
import { signWebhook, verifyWebhook } from './webhooks';

interface Delivery {
  provider: ProviderKind;
  headers: Record<string, string>;
  body: string;
  expected: WebhookVerification;
}

const fixture = loadJson<{
  secret: string;
  githubDocsVector: { secret: string; body: string; signature: string };
  deliveries: Record<string, Delivery>;
}>('webhooks', 'deliveries');
const { secret, deliveries } = fixture;

describe('verifyWebhook', () => {
  it.each(Object.entries(deliveries))('%s verifies with the right secret', (_name, delivery) => {
    expect(verifyWebhook(delivery.provider, delivery.headers, delivery.body, secret)).toEqual(
      delivery.expected,
    );
  });

  it.each(Object.entries(deliveries))('%s fails with a wrong secret', (_name, delivery) => {
    expect(verifyWebhook(delivery.provider, delivery.headers, delivery.body, `${secret}x`)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyWebhook(delivery.provider, delivery.headers, delivery.body, '')).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it.each(Object.entries(deliveries).filter(([, delivery]) => delivery.provider !== 'gitlab'))(
    '%s fails when the body was changed',
    (_name, delivery) => {
      const tampered = `${delivery.body} `;
      expect(verifyWebhook(delivery.provider, delivery.headers, tampered, secret)).toMatchObject({
        ok: false,
      });
    },
  );

  it('matches the test vector from the GitHub docs', () => {
    const vector = fixture.githubDocsVector;
    expect(signWebhook('github', vector.body, vector.secret)).toEqual({
      'X-Hub-Signature-256': vector.signature,
    });
    const result = verifyWebhook(
      'github',
      { 'x-hub-signature-256': vector.signature },
      vector.body,
      vector.secret,
    );
    expect(result).toEqual({ ok: true, event: 'other', eventName: '' });
  });

  it('refuses deliveries without a signature header', () => {
    const body = deliveries['github-push']?.body ?? '';
    expect(verifyWebhook('github', { 'x-github-event': 'push' }, body, secret)).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
    expect(verifyWebhook('gitlab', { 'x-gitlab-event': 'Push Hook' }, body, secret)).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
    // A GitHub-style signature alone does not satisfy the Gitea check.
    expect(
      verifyWebhook(
        'gitea',
        { 'x-hub-signature-256': signWebhook('github', body, secret)['X-Hub-Signature-256'] },
        body,
        secret,
      ),
    ).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('does not accept a GitLab token that is only a prefix of the secret', () => {
    const body = deliveries['gitlab-push']?.body ?? '';
    const headers = { 'X-Gitlab-Event': 'Push Hook', 'X-Gitlab-Token': secret.slice(0, -1) };
    expect(verifyWebhook('gitlab', headers, body, secret)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('accepts a Headers object, array values and a byte body', () => {
    const delivery = deliveries['forgejo-push'] as Delivery;
    const headers = new Headers(delivery.headers);
    const bytes = new TextEncoder().encode(delivery.body);
    expect(verifyWebhook('gitea', headers, bytes, secret)).toEqual(delivery.expected);
    const arrays = Object.fromEntries(
      Object.entries(delivery.headers).map(([name, value]) => [name, [value]]),
    );
    expect(verifyWebhook('gitea', arrays, delivery.body, secret)).toEqual(delivery.expected);
  });

  it('reports a signed body that is not JSON as a bad payload', () => {
    const body = 'not json';
    const headers = { 'X-GitHub-Event': 'push', ...signWebhook('github', body, secret) };
    expect(verifyWebhook('github', headers, body, secret)).toEqual({ ok: false, reason: 'bad_payload' });
  });

  it('is exposed on the provider too', () => {
    const delivery = deliveries['gitlab-push'] as Delivery;
    const provider = createProvider({ provider: 'gitlab', host: 'gitlab.com', token: '' });
    expect(provider.verifyWebhook(delivery.headers, delivery.body, secret)).toEqual(delivery.expected);
  });
});

const requests = loadJson<{
  secret: string;
  deliveries: Record<string, Delivery>;
  malformed: Record<string, Delivery>;
}>('webhooks', 'requests');

describe('verifyWebhook for request events (M7)', () => {
  const all = Object.entries(requests.deliveries);

  it.each(all)('%s verifies and maps the action', (_name, delivery) => {
    expect(verifyWebhook(delivery.provider, delivery.headers, delivery.body, requests.secret)).toEqual(
      delivery.expected,
    );
  });

  it.each(all)('%s fails with a wrong or empty secret', (_name, delivery) => {
    for (const wrong of [`${requests.secret}x`, '']) {
      expect(verifyWebhook(delivery.provider, delivery.headers, delivery.body, wrong)).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
    }
  });

  it.each(all.filter(([, delivery]) => delivery.provider !== 'gitlab'))(
    '%s fails when the body was changed',
    (_name, delivery) => {
      // The action is the one field a forger would want to change.
      const tampered = delivery.body.startsWith('payload=')
        ? delivery.body.replace('%22closed%22', '%22opened%22')
        : delivery.body.replace(/"action":"[a-z_]+"/, '"action":"opened"').replace(/}$/, ',"x":1}');
      expect(tampered).not.toBe(delivery.body);
      expect(verifyWebhook(delivery.provider, delivery.headers, tampered, requests.secret)).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
    },
  );

  it.each(all)('%s without its signature header is refused', (_name, delivery) => {
    const unsigned = Object.fromEntries(
      Object.entries(delivery.headers).filter(([name]) => !/signature|token/i.test(name)),
    );
    expect(verifyWebhook(delivery.provider, unsigned, delivery.body, requests.secret)).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
  });

  it.each(Object.entries(requests.malformed))('%s is a bad payload', (_name, delivery) => {
    expect(verifyWebhook(delivery.provider, delivery.headers, delivery.body, requests.secret)).toEqual(
      delivery.expected,
    );
  });

  it('covers every action and every state on each host', () => {
    for (const provider of ['github', 'gitlab', 'gitea'] as const) {
      const results = all
        .map(([, delivery]) => delivery)
        .filter((delivery) => delivery.provider === provider)
        .map((delivery) => delivery.expected)
        .filter((expected) => expected.ok && expected.event === 'pull_request');
      const actions = new Set(
        results.map((result) => (result.ok && 'action' in result ? result.action : '')),
      );
      const states = new Set(
        results.map((result) => (result.ok && 'request' in result ? result.request.state : '')),
      );
      expect([...actions].sort()).toEqual([...REQUEST_ACTIONS].sort());
      expect([...states].sort()).toEqual([...REQUEST_STATES].sort());
    }
  });

  it('leaves push handling as it was: code that reads push fields still narrows', () => {
    const delivery = deliveries['github-push'] as Delivery;
    const result = verifyWebhook('github', delivery.headers, delivery.body, secret);
    if (!result.ok || result.event !== 'push') throw new Error('expected a push');
    expect(result.branch).toBe('main');
    expect(result.deleted).toBe(false);
  });

  it('reads a request event that is not JSON as a bad payload', () => {
    const body = 'payload=not-json';
    const headers = { 'X-GitHub-Event': 'pull_request', ...signWebhook('github', body, requests.secret) };
    expect(verifyWebhook('github', headers, body, requests.secret)).toEqual({
      ok: false,
      reason: 'bad_payload',
    });
  });

  it('is exposed on the provider too', () => {
    const delivery = requests.deliveries['forgejo-pr-merged'] as Delivery;
    const provider = createProvider({ provider: 'gitea', host: 'forgejo.example.com', token: '' });
    expect(provider.verifyWebhook(delivery.headers, delivery.body, requests.secret)).toEqual(
      delivery.expected,
    );
  });
});

const recorded = loadJson<{ secret: string; deliveries: Record<string, Delivery> }>(
  'webhooks',
  'forgejo-recorded',
);

describe('verifyWebhook on deliveries recorded from Forgejo 17 (M7)', () => {
  const all = Object.entries(recorded.deliveries);

  it.each(all)('%s verifies and maps the action', (_name, delivery) => {
    expect(verifyWebhook('gitea', delivery.headers, delivery.body, recorded.secret)).toEqual(
      delivery.expected,
    );
    expect(verifyWebhook('gitea', delivery.headers, delivery.body, `${recorded.secret}x`)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it.each(all)(
    '%s reads the same when checked as a GitHub delivery, whose headers Forgejo also sends',
    (_name, delivery) => {
      expect(verifyWebhook('github', delivery.headers, delivery.body, recorded.secret)).toEqual(
        delivery.expected,
      );
    },
  );

  it('reads synthetic Forgejo deliveries the same way through GitHub headers', () => {
    const withGitHubHeaders = Object.values(requests.deliveries).filter(
      (delivery) => delivery.provider === 'gitea' && 'X-Hub-Signature-256' in delivery.headers,
    );
    expect(withGitHubHeaders.length).toBeGreaterThan(5);
    for (const delivery of withGitHubHeaders) {
      expect(verifyWebhook('github', delivery.headers, delivery.body, requests.secret)).toEqual(
        delivery.expected,
      );
    }
  });
});
