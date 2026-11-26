import { hasPersonWithEmail } from '@zamu/auth';
import type { Db } from '@zamu/db';
import { z } from 'zod';

// Read-only lookups for the signed-out screens. Server-only: called from server function handlers.

/** Name of the instance's first workspace, shown on the sign-in screen; null before setup. */
export async function loadInstanceName(db: Db): Promise<string | null> {
  const row = await db.query.organization.findFirst({
    columns: { name: true },
    orderBy: { createdAt: 'asc' },
  });
  return row?.name ?? null;
}

export type InvitationState = 'pending' | 'expired' | 'used' | 'canceled' | 'not-found';

export interface InvitationDetails {
  state: InvitationState;
  /** Present unless the invitation does not exist. */
  email: string | null;
  workspaceName: string | null;
  /** The workspace's slug: accepting opens /w/<slug>. */
  workspaceSlug: string | null;
  inviterName: string | null;
  /**
   * Pending invitations only: a person with the invited email exists, so the page asks them to sign in
   * and join instead of offering the sign-up form.
   */
  hasAccount: boolean;
}

const NOT_FOUND: InvitationDetails = {
  state: 'not-found',
  email: null,
  workspaceName: null,
  workspaceSlug: null,
  inviterName: null,
  hasAccount: false,
};

function stateOf(status: string, expiresAt: Date, now: Date): InvitationState {
  if (status === 'accepted') return 'used';
  if (status === 'canceled' || status === 'rejected') return 'canceled';
  if (status === 'expired' || expiresAt.getTime() <= now.getTime()) return 'expired';
  return status === 'pending' ? 'pending' : 'canceled';
}

/** The invitation behind an /invite/$id link. The id is the secret, so unknown ids reveal nothing. */
export async function loadInvitation(db: Db, id: string, now = new Date()): Promise<InvitationDetails> {
  if (!z.uuid().safeParse(id).success) return NOT_FOUND;
  const row = await db.query.invitation.findFirst({
    columns: { email: true, status: true, expiresAt: true },
    with: { organization: { columns: { name: true, slug: true } }, inviter: { columns: { name: true } } },
    where: { id },
  });
  if (!row) return NOT_FOUND;
  const state = stateOf(row.status, row.expiresAt, now);
  return {
    state,
    email: row.email,
    workspaceName: row.organization.name,
    workspaceSlug: row.organization.slug,
    inviterName: row.inviter.name,
    hasAccount: state === 'pending' && (await hasPersonWithEmail(db, row.email)),
  };
}
