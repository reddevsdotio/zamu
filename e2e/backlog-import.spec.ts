// Backlog.md import end to end, against a real Forgejo (e2e/forgejo.ts): an empty project linked to a repository
// whose root backlog.config.yml names the folder planning/, the five setup steps in import mode (with an agent
// of a similar name offered for @claude and an invitation for @alex-agent on the Mappings step), and the
// project afterwards: detached, every field editable by people and agents (the labels, due date and parent
// read from the files included), numbering that continues, and no more refreshes from the files.
//
// The tests build on each other, so they share one page and run in order. Forgejo starts in beforeAll and is
// removed in afterAll. E2E_SKIP_BACKLOG=1 skips the spec; so does a missing Docker daemon.
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createCli, parseJson } from './cli';
import { addConnection, dockerAvailable, type Forgejo, readTree, startForgejo } from './forgejo';
import { addAgent, api, collectPageErrors, settle, signInAsAdmin, w } from './session';
import { baseURL, forgejoAliases, mainStack, repoRoot } from './stack';

const repo = 'backlog-demo';
const project = { name: 'Backlog Demo', key: 'DEMO' };
const agentName = 'import-agent';
/** An existing agent the Mappings step offers for @claude (work-views.spec.ts adds it too). */
const similarAgent = 'claude-dev';
const invitedEmail = 'alex@example.com';
/** Root backlog.config.yml naming planning/ as the folder, ISO timestamps, a subtask and a draft. */
const fixture = `${repoRoot}/packages/backlog-md/test/fixtures/eras/2026-10-iso`;
const subtaskPath = 'planning/tasks/back-786.1 - Parse-the-folder.md';

interface TaskShape {
  key: string;
  title: string;
  status: string;
  assignee: { name: string } | null;
  locked?: string[];
  backlog: { id: string } | null;
  labels: { name: string; source: string }[];
  dueDate: string | null;
  parent: { key: string } | null;
}
interface SourceStatus {
  mode: string;
  state: string;
  lastRead: { commit: string } | null;
}

test.describe.configure({ mode: 'serial' });
test.skip(process.env.E2E_SKIP_BACKLOG === '1', 'E2E_SKIP_BACKLOG=1');
test.skip(!dockerAvailable(), 'Docker is not available: the Backlog.md specs need it to run Forgejo.');

let context: BrowserContext;
let page: Page;
let forgejo: Forgejo;
const pageErrors: string[] = [];
const cli = createCli();

async function taskOf(key: string): Promise<TaskShape> {
  return api<TaskShape>(page.request, 'GET', `/tasks/${key}`);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  forgejo = await startForgejo('import', mainStack.network, forgejoAliases.import);
  const files = readTree(fixture);
  // The subtask goes to @claude, a coding agent with no member of that name.
  files[subtaskPath] = (files[subtaskPath] as string).replace('assignee: []', "assignee:\n  - '@claude'");
  await forgejo.createRepository(repo, { 'README.md': '# Backlog demo\n', ...files });

  context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    timezoneId: 'UTC',
  });
  page = await context.newPage();
  collectPageErrors(page, pageErrors, [
    // The refused refresh of a detached source answers 409 on purpose.
    /status of 409\b/,
  ]);
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern as the first argument.
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && page) {
    await testInfo.attach('page at failure', { body: await page.screenshot(), contentType: 'image/png' });
  }
});

test.afterAll(async () => {
  await context?.close();
  cli.dispose();
  if (process.env.E2E_KEEP_STACK === '1') {
    console.log('[e2e] leaving the import spec Forgejo running; the next pnpm e2e run removes it');
    return;
  }
  forgejo?.stop();
});

test('import: the five setup steps on an empty project linked to the repository', async () => {
  await signInAsAdmin(page);
  await addConnection(page, forgejo, 'Forgejo · e2e import');
  await api(page.request, 'POST', '/projects', { ...project, repository: forgejo.repositoryUrl(repo) });
  const members = await api<{ items: { name: string }[] }>(page.request, 'GET', '/members');
  if (!members.items.some((member) => member.name === similarAgent)) {
    await addAgent(page, similarAgent, [project.key]);
  }

  await page.goto(w(`/p/${project.key}/backlog-setup?mode=import`));
  await settle(page);
  await expect(page.getByRole('heading', { name: `Import Backlog.md into ${project.name}` })).toBeVisible();

  // 1. Mode
  await expect(page.getByRole('radio', { name: /Import once/ })).toBeChecked();
  await page.getByRole('button', { name: 'Continue' }).click();

  // 2. Source: the connection is picked by host, and the folder comes from backlog.config.yml.
  await expect(page.getByText('planning/').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Continue' }).click();

  // 3. Mappings: every status matches by name.
  const statusMapping = page.getByRole('group', { name: 'Status mapping' });
  await expect(statusMapping.getByRole('button', { name: /In Progress maps to/ })).toHaveAccessibleName(
    /^In progress/,
  );
  const assignees = page.getByRole('group', { name: 'Assignee mapping' });
  // @claude matches no member, but claude-dev shares the agent word: map to it or create claude.
  const claude = assignees.getByRole('button', { name: /@claude maps to/ });
  await expect(claude).toHaveAccessibleName(/^No one/);
  const agentLine = page
    .getByRole('region', { name: 'Agent suggestions' })
    .getByRole('listitem')
    .filter({ hasText: '@claude may be' });
  await expect(agentLine).toContainText(`@claude may be ${similarAgent}.`);
  await expect(agentLine.getByRole('button', { name: 'Create agent claude' })).toBeVisible();
  await agentLine.getByRole('button', { name: `Map to ${similarAgent}` }).click();
  await expect(claude).toHaveAccessibleName(new RegExp(`^${similarAgent}`));
  await expect(agentLine).toHaveCount(0);

  // @alex-agent does not look like a coding agent: invite the person.
  const invites = page.getByRole('region', { name: 'People to invite' });
  await expect(invites).toContainText('No member matches this name yet.');
  const alexLine = invites.getByRole('listitem').filter({ hasText: '@alex-agent' });
  await expect(alexLine).toContainText('@alex-agent matches no member.');
  await alexLine.getByRole('button', { name: 'Invite…' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite person' });
  await expect(invite).toContainText('For @alex-agent in the files (1 task).');
  await invite.getByLabel('Email').fill(invitedEmail);
  await invite.getByRole('button', { name: 'Create invitation link' }).click();
  const link = page.getByRole('dialog', { name: 'Invitation link' });
  await expect(link).toContainText(`Invitation for ${invitedEmail}`);
  await link.getByRole('button', { name: 'Done' }).click();
  await expect(link).toBeHidden();
  await expect(alexLine).toContainText(
    `Invited ${invitedEmail}. Once they join, map @alex-agent in Settings › Backlog.md › Edit mappings.`,
  );
  await expect(alexLine.getByRole('button', { name: 'Invite…' })).toHaveCount(0);
  await expect(assignees.getByRole('button', { name: /@alex-agent maps to/ })).toHaveAccessibleName(
    /^No one/,
  );
  await page.getByRole('button', { name: 'Preview' }).click();

  // 4. Preview: the task, its subtask and the draft.
  await expect(page.getByRole('heading', { name: `Import 3 tasks into ${project.name}?` })).toBeVisible({
    timeout: 20_000,
  });
  const sample = page.getByRole('region', { name: 'Sample' });
  await expect(sample.getByRole('listitem').filter({ hasText: 'BACK-786.1' })).toContainText(
    `${project.key}-786.1`,
  );
  await expect(sample.getByRole('listitem').filter({ hasText: 'DRAFT-14' })).toContainText(
    `${project.key}-787`,
  );

  // 5. Read, then detach in the same job.
  await page.getByRole('button', { name: 'Import 3 tasks' }).click();
  await expect(page.getByText(`${project.name} imported`)).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByText('The project is detached from the files: every task is editable here.'),
  ).toBeVisible();

  const status = await api<SourceStatus>(page.request, 'GET', `/projects/${project.key}/backlog`);
  expect(status).toMatchObject({ mode: 'import', state: 'detached' });
  expect(status.lastRead?.commit).toBe(await forgejo.head(repo));
});

test('after the import every field is editable and the numbering continues', async () => {
  const task = await taskOf(`${project.key}-786`);
  expect(task).toMatchObject({ title: 'Mirror Backlog.md', status: 'in_progress', locked: [] });
  expect(task.assignee).toBeNull();
  // Mapped to the similar agent on the Mappings step.
  expect((await taskOf(`${project.key}-786.1`)).assignee?.name).toBe(similarAgent);
  // The Backlog.md record stays on the task, and its ID still finds it.
  expect(task.backlog?.id).toBe('BACK-786');
  expect((await taskOf('BACK-786.1')).key).toBe(`${project.key}-786.1`);

  // Labels, the due date and the parent came from the files as native fields. The import detached the
  // project, so they are the app's own now: the label is an app label, and nothing is locked.
  expect(task.labels).toEqual([expect.objectContaining({ name: 'cli', source: 'app' })]);
  expect(task.dueDate).toBe('2026-11-15');
  expect((await taskOf(`${project.key}-786.1`)).parent?.key).toBe(`${project.key}-786`);
  const labels = await api<{ items: { id: string; name: string; source: string; usageCount: number }[] }>(
    page.request,
    'GET',
    `/projects/${project.key}/labels`,
  );
  expect(labels.items).toEqual([expect.objectContaining({ name: 'cli', source: 'app', usageCount: 1 })]);
  await api(page.request, 'PATCH', `/projects/${project.key}/labels/${labels.items[0]?.id}`, {
    name: 'pm-cli',
  });

  const updated = await api<TaskShape>(page.request, 'PATCH', `/tasks/${project.key}-786`, {
    title: 'Mirror Backlog.md folders',
    status: 'done',
    addLabels: ['docs'],
    dueDate: null,
  });
  expect(updated).toMatchObject({ title: 'Mirror Backlog.md folders', status: 'done', dueDate: null });
  expect(updated.labels.map((label) => label.name).sort()).toEqual(['docs', 'pm-cli']);

  const milestones = await api<{ items: { id: string; name: string }[] }>(
    page.request,
    'GET',
    `/projects/${project.key}/milestones`,
  );
  const milestone = milestones.items.find((item) => item.name === 'Agent CLI Workflow');
  expect(milestone).toBeDefined();
  await api(page.request, 'PATCH', `/milestones/${milestone?.id}`, { name: 'Agent CLI' });

  // The draft took 787, so the next task is 788.
  const created = await api<TaskShape>(page.request, 'POST', '/tasks', {
    project: project.key,
    title: 'Document the import',
  });
  expect(created.key).toBe(`${project.key}-788`);

  await page.goto(w(`/p/${project.key}`));
  await settle(page);
  await expect(page.getByRole('button', { name: /^Backlog\.md: / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New task', exact: true })).toBeEnabled();
});

test('agents edit imported tasks with zamu; the files no longer reach the project', async () => {
  const apiKey = await addAgent(page, agentName, [project.key]);
  const login = cli.run(['login', '--key', apiKey, '--url', baseURL, '--json']);
  expect(login.code, login.stdout + login.stderr).toBe(0);

  const update = cli.run(['tasks', 'update', 'BACK-786.1', '--status', 'in_progress', '--json']);
  expect(update.code, update.stdout + update.stderr).toBe(0);
  expect(parseJson<TaskShape>(update, 'zamu.v1.tasks.update').status).toBe('in_progress');

  // A push changes nothing, and a refresh is refused: the source is detached.
  await forgejo.commit(repo, 'Rename the parent task', {
    'planning/tasks/back-786 - Mirror-Backlog-md.md': readTree(fixture)[
      'planning/tasks/back-786 - Mirror-Backlog-md.md'
    ]?.replace('title: Mirror Backlog.md', 'title: Renamed in git') as string,
  });
  const refresh = cli.run(['backlog', 'refresh', '--project', project.key]);
  expect(refresh.code, refresh.stdout + refresh.stderr).toBe(6);
  expect((await taskOf(`${project.key}-786`)).title).toBe('Mirror Backlog.md folders');
  expect(pageErrors).toEqual([]);
});
