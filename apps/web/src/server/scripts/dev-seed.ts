// Seeds local development data and prints fresh API keys.
//
//   pnpm exec tsx --env-file-if-exists=.env apps/web/src/server/scripts/dev-seed.ts      (repo root)
//   eval "$(pnpm -s exec tsx --env-file-if-exists=.env apps/web/src/server/scripts/dev-seed.ts)"
//
// stdout carries only `export ...` lines, so `eval` sets them; the summary goes to stderr.
// ZAMU_API_KEY (claude-dev's key) and ZAMU_ADMIN_API_KEY (the admin's) are for the first workspace;
// ZAMU_SECOND_API_KEY and ZAMU_SECOND_ADMIN_API_KEY are the same two for the second workspace, Globex,
// whose PAY project shares its key with the first workspace's. Reads DATABASE_URL, BETTER_AUTH_SECRET,
// BETTER_AUTH_URL and PUBLIC_URL; SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD and SEED_WORKSPACE override
// the first-run admin and workspace. SEED_PLANNING=0 skips the demo data of M2 and later (planning,
// dashboard, pull requests, archive, check again, waves and gates); SEED_SECOND_WORKSPACE=0 skips
// Globex; SEED_BACKLOG=1 adds the mirrored Backlog.md project BACK (needs APP_ENCRYPTION_KEY).
// Never run it against production.
import { createServerContext } from '../context';
import { SEED_DEFAULTS, seedDevData } from '../seed';

async function main() {
  const ctx = createServerContext(process.env);
  try {
    const result = await seedDevData(ctx, {
      adminEmail: process.env.SEED_ADMIN_EMAIL || SEED_DEFAULTS.adminEmail,
      adminPassword: process.env.SEED_ADMIN_PASSWORD || SEED_DEFAULTS.adminPassword,
      workspaceName: process.env.SEED_WORKSPACE || SEED_DEFAULTS.workspaceName,
      planning: process.env.SEED_PLANNING !== '0',
      backlog: process.env.SEED_BACKLOG === '1',
      dashboard: process.env.SEED_PLANNING !== '0',
      pullRequests: process.env.SEED_PLANNING !== '0',
      waves: process.env.SEED_PLANNING !== '0',
      secondWorkspace: process.env.SEED_SECOND_WORKSPACE !== '0',
    });
    const projects = (list: { key: string; tasks: number }[]) =>
      list.length
        ? list.map((p) => `${p.key} (${p.tasks} tasks)`).join(', ')
        : 'the seed projects already existed; left unchanged';
    const log = (line = '') => process.stderr.write(`${line}\n`);
    log(result.bootstrapped ? 'Set up the instance (first run).' : 'Instance already set up; added to it.');
    log(`Web app:   ${ctx.publicUrl}`);
    log(
      result.admin.password
        ? `Sign in:   ${result.admin.email} / ${result.admin.password}`
        : `Admin:     ${result.admin.name} <${result.admin.email}> (existing password)`,
    );
    log();
    log(`Workspace: ${result.workspace.name}, ${ctx.publicUrl}/w/${result.workspace.slug}`);
    log(`Agent:     ${result.agent.name}, acting for ${result.admin.name}`);
    if (result.member) log(`Member:    ${result.member.name} <${result.member.email}>`);
    log(`Projects:  ${projects(result.createdProjects)}`);
    log('API keys (shown once), all projects, read and write: ZAMU_API_KEY (agent), ZAMU_ADMIN_API_KEY');
    process.stdout.write(`export ZAMU_API_KEY=${result.agentKey}\n`);
    process.stdout.write(`export ZAMU_ADMIN_API_KEY=${result.adminKey}\n`);
    const second = result.second;
    if (second) {
      log();
      log(`Workspace: ${second.workspace.name}, ${ctx.publicUrl}/w/${second.workspace.slug}`);
      log(
        `Agent:     ${second.agent.name} (its own agent in this workspace), acting for ${result.admin.name}`,
      );
      log(`Projects:  ${projects(second.createdProjects)}`);
      log(
        'API keys (shown once), all projects, read and write: ZAMU_SECOND_API_KEY (agent), ZAMU_SECOND_ADMIN_API_KEY',
      );
      process.stdout.write(`export ZAMU_SECOND_API_KEY=${second.agentKey}\n`);
      process.stdout.write(`export ZAMU_SECOND_ADMIN_API_KEY=${second.adminKey}\n`);
    }
    log();
    log(`Try: curl -H "Authorization: Bearer $ZAMU_API_KEY" ${ctx.publicUrl}/api/v1/projects`);
  } finally {
    await ctx.jobs.stop();
    await ctx.pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('dev-seed failed:', error);
  process.exitCode = 1;
});
