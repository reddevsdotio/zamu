// The caller: user, workspace, role and how far their credentials reach; their preferences.
// The workspace is the one the request resolved to, named by its current slug.
import { Me, UpdateMeInput } from '@zamu/contracts';
import { schema } from '@zamu/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { type Actor, authorize, isSession } from './authz';
import type { DbContext } from './context';
import { NotFound, parseInput } from './errors';
import { loadUsers, userRef } from './internal';

export async function getMe({ db }: DbContext, actor: Actor): Promise<Me> {
  authorize(actor, 'workspace.read');
  const [[me], [workspace]] = await Promise.all([
    db.select().from(schema.user).where(eq(schema.user.id, actor.userId)).limit(1),
    db.select().from(schema.organization).where(eq(schema.organization.id, actor.workspaceId)).limit(1),
  ]);
  if (!me || !workspace) throw new NotFound('User or workspace not found');

  const responsible =
    me.kind === 'agent' && me.responsibleUserId
      ? (await loadUsers(db, [me.responsibleUserId])).get(me.responsibleUserId)
      : undefined;

  let scope = null;
  if (actor.scope) {
    const { projects, access } = actor.scope;
    if (projects === 'all') scope = { projects: 'all' as const, access };
    else {
      const rows = projects.length
        ? await db
            .select({ id: schema.project.id, key: schema.project.key, name: schema.project.name })
            .from(schema.project)
            .where(
              and(eq(schema.project.workspaceId, actor.workspaceId), inArray(schema.project.id, projects)),
            )
        : [];
      scope = { projects: rows.filter((row) => projects.includes(row.id)), access };
    }
  }

  return Me.parse({
    user: {
      id: me.id,
      name: me.name,
      email: me.kind === 'agent' ? null : me.email,
      kind: me.kind,
      responsible: responsible ? userRef(responsible) : null,
      theme: me.theme,
    },
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    role: actor.role,
    auth: { method: isSession(actor) ? 'session' : 'api_key', scope },
  });
}

/**
 * Changes the caller's own preferences (the theme). People signed in with a session only:
 * API keys and agents get Forbidden. Returns the updated Me.
 */
export async function updateMe(
  ctx: DbContext,
  actor: Actor,
  input: z.input<typeof UpdateMeInput>,
): Promise<Me> {
  authorize(actor, 'profile.update');
  const { theme } = parseInput(UpdateMeInput, input);
  const [row] = await ctx.db
    .update(schema.user)
    .set({ theme })
    .where(eq(schema.user.id, actor.userId))
    .returning({ id: schema.user.id });
  if (!row) throw new NotFound('User not found');
  return getMe(ctx, actor);
}
