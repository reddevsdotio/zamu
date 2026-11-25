// The work record end to end (0.9.0): an agent works a task through the CLI from a clone on a feature branch
// (acceptance criteria and a plan at creation, work notes, a checked criterion and the final summary) and is
// refused at In review while a criterion is open (OPEN_ITEMS, exit code 1, with the flags that settle it). The
// person opens the task, moves it to In review, waives the open criterion in the finishing dialog and moves
// it. The timeline's Notes filter shows the agent's notes, and History shows the machine and branch the CLI
// sent. Then Settings > Task defaults: default done items added on the page start every new task, from the
// web app and from the CLI, unless the agent leaves them out.
//
// The tests build on each other, so they share one page and run in order.
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createCli, parseJson } from './cli';
import { createGitRepo, type GitRepo } from './git-repo';
import { addAgent, admin, api, collectPageErrors, settle, signInAsAdmin } from './session';
import { baseURL } from './stack';

const project = { name: 'Payouts', key: 'OUT' };
const agentName = 'payout-agent';
/** What the CLI sends as x-zamu-machine and x-zamu-branch. */
const machine = 'build-box';
const branch = 'feat/payout-retries';
const criteria = ['A failed payout is retried up to 8 times', 'On-call is alerted once per payout'];
const plan = '1. Add a retry queue.\n2. Back off exponentially.';
const notes = ['Retry queue written and tested', 'Backoff schedule covered by tests'];
const summary = 'Failed payouts retry with backoff; on-call alerting moves to its own task.';
const waiveReason = 'Alerting moves to its own task';
const defaults = ['Tests and lint pass', 'Changelog has a line'];
/** First name of the agent's person: history lines read "payout-agent for Ana". */
const person = admin.name.split(' ')[0] as string;

interface WorkItem {
  number: number;
  text: string;
  state: 'open' | 'checked' | 'waived';
  waivedReason: string | null;
  waivedBy: { name: string } | null;
  locked: boolean;
}
interface TaskShape {
  key: string;
  title: string;
  status: string;
  criteria?: WorkItem[];
  doneItems?: WorkItem[];
  plan?: string | null;
  finalSummary?: string | null;
}
interface Problem {
  code: string;
  status: number;
  openItems?: { kind: string; number: number; text: string }[];
}
interface TimelineShape {
  items: { kind: string; body?: string; source?: { machine: string | null; branch: string | null } | null }[];
  counts: { all: number; comments: number; notes: number; history: number };
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
let repo: GitRepo;
let taskKey = '';
const pageErrors: string[] = [];
const cli = createCli();

/** zamu as the agent, from the clone on the feature branch. */
function agent(args: string[]) {
  return cli.run(args, { ZAMU_MACHINE: machine }, { cwd: repo.dir });
}

async function taskOf(key: string): Promise<TaskShape> {
  return api<TaskShape>(page.request, 'GET', `/tasks/${key}`);
}

/** The task view's Properties sidebar. */
function properties() {
  return page.getByRole('complementary', { name: 'Properties' });
}

/** The task view's criteria or done items section. */
function workList(kind: 'criterion' | 'done') {
  return page.locator(`[data-work-list="${kind}"]`);
}

function activity() {
  return page.getByRole('region', { name: 'Activity' });
}

/** One of the timeline's filters (All, Comments, Notes, History); long timelines add a count to the name. */
function filter(name: string) {
  return activity()
    .getByRole('group', { name: 'Show' })
    .getByRole('button', { name: new RegExp(`^${name}\\b`) });
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    timezoneId: 'UTC',
  });
  page = await context.newPage();
  collectPageErrors(page, pageErrors);
  repo = createGitRepo(branch);
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
  repo?.remove();
});

test('an agent creates a task with criteria and a plan, writes notes and checks what it proved', async () => {
  await signInAsAdmin(page);
  await api(page.request, 'POST', '/projects', project);
  const key = await addAgent(page, agentName, [project.key]);
  const login = cli.run(['login', '--key', key, '--url', baseURL, '--json']);
  expect(login.code, login.stdout + login.stderr).toBe(0);

  const created = agent([
    'tasks',
    'create',
    '--project',
    project.key,
    'Retry failed payouts',
    '--ac',
    criteria[0] as string,
    '--ac',
    criteria[1] as string,
    '--plan',
    plan,
    '--json',
  ]);
  expect(created.code, created.stdout + created.stderr).toBe(0);
  const task = parseJson<TaskShape>(created, 'zamu.v1.tasks.create');
  taskKey = task.key;
  expect(task.criteria?.map(({ number, text, state }) => ({ number, text, state }))).toEqual([
    { number: 1, text: criteria[0], state: 'open' },
    { number: 2, text: criteria[1], state: 'open' },
  ]);
  // The project has no default done items yet.
  expect(task.doneItems).toEqual([]);
  expect(task.plan).toBe(plan);

  // A status change with a note: the note goes in after the update.
  const started = agent([
    'tasks',
    'update',
    taskKey,
    '--status',
    'in_progress',
    '--append-notes',
    notes[0] as string,
    '--json',
  ]);
  expect(started.code, started.stdout + started.stderr).toBe(0);
  expect(parseJson<TaskShape>(started, 'zamu.v1.tasks.update').status).toBe('in_progress');
  const note = agent(['notes', 'add', taskKey, notes[1] as string, '--json']);
  expect(note.code, note.stdout + note.stderr).toBe(0);
  expect(parseJson<{ kind: string; body: string }>(note, 'zamu.v1.notes.add')).toMatchObject({
    kind: 'note',
    body: notes[1],
  });

  const checked = agent([
    'tasks',
    'update',
    taskKey,
    '--check-ac',
    '1',
    '--final-summary',
    summary,
    '--json',
  ]);
  expect(checked.code, checked.stdout + checked.stderr).toBe(0);
  const after = parseJson<TaskShape>(checked, 'zamu.v1.tasks.update');
  expect(after.criteria?.map((item) => item.state)).toEqual(['checked', 'open']);
  expect(after.finalSummary).toBe(summary);
});

test('the agent is refused at In review while a criterion is open', async () => {
  const refused = agent(['tasks', 'update', taskKey, '--status', 'in_review', '--json']);
  expect(refused.code, refused.stdout + refused.stderr).toBe(1);
  expect(parseJson<Problem>(refused, 'zamu.v1.error')).toMatchObject({
    code: 'OPEN_ITEMS',
    status: 409,
    openItems: [{ kind: 'criterion', number: 2, text: criteria[1] }],
  });

  // Without --json zamu names the open item and the flags that settle it.
  const text = agent(['tasks', 'update', taskKey, '--status', 'in_review']);
  expect(text.code, text.stdout + text.stderr).toBe(1);
  const output = text.stdout + text.stderr;
  expect(output).toContain(criteria[1]);
  expect(output).toContain('--check-ac 2');
  expect(output).toContain('--waive-ac 2');
  expect((await taskOf(taskKey)).status).toBe('in_progress');
});

test('the person waives the open criterion in the finishing dialog and moves the task', async () => {
  await page.goto(`/p/${project.key}/${taskKey}`);
  await settle(page);
  await expect(workList('criterion')).toContainText(criteria[0] as string);
  await expect(workList('criterion')).toContainText(criteria[1] as string);
  await expect(page.getByText(summary)).toBeVisible();
  await expect(page.getByText('Add a retry queue.')).toBeVisible();

  const status = properties().getByRole('button', { name: 'Status' });
  await expect(status).toContainText('In progress');
  await status.click();
  await page.getByRole('menu', { name: 'Status' }).getByRole('menuitemradio', { name: 'In review' }).click();

  // The move waits for the dialog, which lists the open criterion.
  const dialog = page.getByRole('dialog').filter({ hasText: `${taskKey} is moving to In review.` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '1 item is still open' })).toBeVisible();
  await expect(dialog).toContainText(criteria[1] as string);
  await dialog.getByRole('button', { name: 'Waive criterion 2' }).click();
  const reason = page.getByRole('textbox', { name: 'Waive criterion 2' });
  await expect(reason).toBeFocused();
  await reason.fill(waiveReason);
  await reason.press('Enter');
  // Enter waives the item and nothing else: the dialog stays open until the person moves the task.
  await expect(dialog.getByRole('heading', { name: 'Every item is checked or waived' })).toBeVisible();
  await dialog.getByRole('button', { name: /^Move to In review/ }).click();
  await expect(dialog).toBeHidden();
  await expect(status).toContainText('In review');

  const task = await taskOf(taskKey);
  expect(task.status).toBe('in_review');
  expect(task.criteria?.[1]).toMatchObject({
    state: 'waived',
    waivedReason: waiveReason,
    waivedBy: { name: admin.name },
  });
  await expect(workList('criterion')).toContainText(`Waived by ${admin.name}: ${waiveReason}`);
});

test("the Notes filter shows the agent's notes; History shows the machine and branch", async () => {
  // The API counts every filter and returns the notes with their source.
  const timeline = await api<TimelineShape>(page.request, 'GET', `/tasks/${taskKey}/timeline?show=notes`);
  expect(timeline.counts.notes).toBe(2);
  expect(timeline.items.map((item) => item.kind)).toEqual(['note', 'note']);
  expect(timeline.items.map((item) => item.body)).toEqual(notes);
  for (const item of timeline.items) expect(item.source).toEqual({ machine, branch });

  await page.reload();
  await settle(page);
  await filter('Notes').click();
  await expect(filter('Notes')).toHaveAttribute('aria-pressed', 'true');
  const shown = activity().getByRole('article', { name: `Note by ${agentName} for ${person}` });
  await expect(shown).toHaveCount(2);
  await expect(shown.first()).toContainText(notes[0] as string);
  await expect(shown.last()).toContainText(notes[1] as string);
  // Changes are left out under Notes.
  await expect(activity().getByText('moved this to In progress')).toHaveCount(0);

  await filter('History').click();
  const started = activity()
    .getByRole('listitem')
    .filter({ hasText: `${agentName} for ${person} moved this to In progress` });
  await expect(started).toBeVisible();
  await expect(started).toContainText(machine);
  await expect(started).toContainText(branch);
  // The person's move came from the web app, which sends neither.
  const moved = activity()
    .getByRole('listitem')
    .filter({ hasText: `${admin.name} moved this to In review` });
  await expect(moved).toBeVisible();
  await expect(moved).not.toContainText(machine);
  await filter('All').click();
});

test('Task defaults: default done items start every new task', async () => {
  await page.goto(`/p/${project.key}/settings/defaults`);
  await settle(page);
  await expect(page.getByRole('heading', { name: 'Task defaults' })).toBeVisible();
  await expect(page.getByText('No default items')).toBeVisible();
  await page.getByRole('button', { name: 'Add an item' }).first().click();
  const field = page.getByRole('textbox', { name: 'New default item' });
  for (const text of defaults) {
    await field.fill(text);
    await field.press('Enter');
    await expect(page.getByRole('list', { name: 'Default done items' })).toContainText(text);
    // The field stays open, empty, for the next item.
    await expect(field).toHaveValue('');
  }
  await field.press('Escape');
  const projects = await api<{ items: { key: string; defaultDoneItems?: string[] }[] }>(
    page.request,
    'GET',
    '/projects',
  );
  expect(projects.items.find((item) => item.key === project.key)?.defaultDoneItems).toEqual(defaults);

  // A task created in the web app starts with them.
  const title = 'Send payout receipts';
  await page.goto(`/p/${project.key}`);
  await settle(page);
  await page.keyboard.press('c');
  const create = page.getByRole('dialog', { name: 'New task' });
  await expect(create).toBeVisible();
  await create.getByRole('textbox', { name: 'Title' }).fill(title);
  await page.keyboard.press('Control+Enter');
  let createdKey = '';
  await expect
    .poll(async () => {
      const list = await api<{ items: TaskShape[] }>(
        page.request,
        'GET',
        `/tasks?project=${project.key}&q=${encodeURIComponent(title)}`,
      );
      createdKey = list.items.find((item) => item.title === title)?.key ?? '';
      return createdKey;
    })
    .not.toBe('');
  if (await create.isVisible()) await page.keyboard.press('Escape');
  const created = await taskOf(createdKey);
  expect(created.doneItems?.map(({ text, state }) => ({ text, state }))).toEqual(
    defaults.map((text) => ({ text, state: 'open' })),
  );
  await page.goto(`/p/${project.key}/${createdKey}`);
  await settle(page);
  for (const text of defaults) await expect(workList('done')).toContainText(text);
  await expect(workList('done')).toContainText('from the project defaults');

  // From the CLI: the defaults come first, then the agent's own; --no-dod-defaults leaves them out.
  const withOwn = agent([
    'tasks',
    'create',
    '--project',
    project.key,
    'Retry refunds',
    '--dod',
    'Runbook updated',
    '--json',
  ]);
  expect(withOwn.code, withOwn.stdout + withOwn.stderr).toBe(0);
  expect(parseJson<TaskShape>(withOwn, 'zamu.v1.tasks.create').doneItems?.map((item) => item.text)).toEqual([
    ...defaults,
    'Runbook updated',
  ]);
  const without = agent([
    'tasks',
    'create',
    '--project',
    project.key,
    'Fix a typo in the receipt',
    '--no-dod-defaults',
    '--json',
  ]);
  expect(without.code, without.stdout + without.stderr).toBe(0);
  expect(parseJson<TaskShape>(without, 'zamu.v1.tasks.create').doneItems).toEqual([]);
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});
