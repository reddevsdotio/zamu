// Waves and gates end to end (M8). A planning agent sets a milestone up from the CLI: the plan link, three
// waves with what their gates check, and its tasks put in them; `zamu milestones show` prints the plan with
// the lock on W2 and W3. The agent is refused when it starts a W2 task (WAVE_LOCKED, exit 1), while a person
// who starts one in the web app gets the "W2 is still locked" warning and starts it anyway. On the milestone
// page Pass stays disabled until W1's tasks are done, `zamu waves pass` is refused before that
// (GATE_TASKS_OPEN) and works after; W2 becomes the current wave. The person fails W2's gate from the page,
// and the stop line goes across the top. A task moves to W3 and back with Alt+↓ and Alt+↑, the milestone
// list shows each milestone's wave status, and the page reads the same in the dark theme.
//
// The tests build on each other, so they share one page and run in order.
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createCli, parseJson } from './cli';
import { addAgent, api, collectPageErrors, settle, signInAsAdmin, w } from './session';
import { baseURL } from './stack';

const project = { name: 'Settlements', key: 'STL' };
const agentName = 'planning-agent';
const person = 'Ana Ruiz';
const milestoneName = 'Payouts v2';
const planPath = 'plans/payouts-v2.html';
const waves = [
  { name: 'Data and contracts', gate: 'Migrations apply on a fresh database and the contract tests pass' },
  { name: 'Screens', gate: 'Every screen matches the design in light and dark' },
  { name: 'End-to-end tests', gate: 'The full suite passes against the image' },
] as const;
/** STL-1 to STL-6: two tasks in W1, two in W2, one in W3 and one in no wave. */
const titles = [
  'Ledger tables for payouts',
  'Payout contracts',
  'Payout list screen',
  'Payout detail screen',
  'Payout flow spec',
  'Write the release notes',
];
const passNote = 'Migrations applied on a fresh database; 42 contract tests pass.';
const failNote = 'The detail screen has no dark theme yet.';

interface WaveRef {
  id: string;
  number: number;
  name: string;
  locked: boolean;
  lockedUntil: { number: number; name: string } | null;
}
interface TaskShape {
  key: string;
  status: string;
  milestone: { id: string; name: string } | null;
  wave: WaveRef | null;
}
interface WaveShape {
  id: string;
  number: number;
  name: string;
  current: boolean;
  locked: boolean;
  lockedUntil: { number: number; name: string } | null;
  canPass: boolean;
  openKeys: string[];
  gate: {
    description: string | null;
    state: string;
    result: {
      state: string;
      note: string;
      recordedBy: { name: string };
      onBehalfOf: { name: string } | null;
    } | null;
  };
  progress: { total: number; done: number; canceled: number; open: number };
  tasks: { key: string }[];
}
interface PlanShape {
  milestone: { id: string; name: string };
  planUrl: string | null;
  waves: WaveShape[];
  notInWave: { key: string }[];
}

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
let milestoneId = '';
const pageErrors: string[] = [];
const cli = createCli();

async function taskOf(key: string): Promise<TaskShape> {
  return api<TaskShape>(page.request, 'GET', `/tasks/${key}`);
}

async function planOf(): Promise<PlanShape> {
  return api<PlanShape>(page.request, 'GET', `/milestones/${milestoneId}/plan`);
}

/** zamu as the agent; the JSON result of a command that worked. */
function zamu<T>(args: string[], schema: string): T {
  const result = cli.run([...args, '--json']);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return parseJson<T>(result, schema);
}

/** zamu as the agent, text output. */
function zamuText(args: string[]): string {
  const result = cli.run(args);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return result.stdout;
}

function properties() {
  return page.getByRole('complementary', { name: 'Properties' });
}

function wavesRegion() {
  return page.getByRole('region', { name: 'Waves' });
}

/** The header of wave `number` (its fold button carries the name). */
function waveHeader(number: number) {
  const wave = waves[number - 1];
  return page
    .locator('[data-part="wave-header"]')
    .filter({ has: page.getByRole('button', { name: `W${number} · ${wave?.name}`, exact: true }) });
}

function gateBox(number: number) {
  return page.getByRole('group', { name: `Gate of W${number} · ${waves[number - 1]?.name}` });
}

function row(key: string) {
  return wavesRegion().locator(`li[data-key="${key}"]`);
}

function toast(text: string | RegExp) {
  return page.getByRole('status').filter({ hasText: text });
}

async function openMilestone(): Promise<void> {
  await page.goto(w(`/p/${project.key}/milestones/${milestoneId}`));
  await settle(page);
  await expect(page.getByRole('heading', { level: 1, name: milestoneName })).toBeVisible();
  await expect(wavesRegion()).toBeVisible();
}

/**
 * Moves the list focus with J (then K, if it started past the row) until it lands on `key`. Rows of
 * collapsed waves are not in the list.
 */
async function focusRow(key: string): Promise<void> {
  const focused = async () => (await row(key).getAttribute('data-focused')) != null;
  for (const step of ['j', 'k']) {
    for (let count = 0; count <= titles.length; count += 1) {
      if (await focused()) return;
      await page.keyboard.press(step);
    }
  }
  await expect(row(key)).toHaveAttribute('data-focused', 'true');
}

/** Relative luminance of a CSS colour, read back through a canvas (the tokens are oklch). */
async function luminance(selector: string): Promise<number> {
  return page.evaluate((target) => {
    const element = document.querySelector(target);
    if (!element) throw new Error(`no ${target}`);
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const paint = canvas.getContext('2d');
    if (!paint) throw new Error('no canvas');
    paint.fillStyle = getComputedStyle(element).backgroundColor;
    paint.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = paint.getImageData(0, 0, 1, 1).data;
    const linear = (value: number) => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  }, selector);
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    timezoneId: 'UTC',
  });
  page = await context.newPage();
  collectPageErrors(page, pageErrors);
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires an object pattern as the first argument.
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && page) {
    await testInfo.attach('page at failure', { body: await page.screenshot(), contentType: 'image/png' });
  }
});

test.afterAll(async () => {
  // The theme is the admin's, shared with the other specs: leave it on System.
  if (page) await page.request.patch('/api/v1/me', { data: { theme: 'system' } }).catch(() => undefined);
  await context?.close();
  cli.dispose();
});

test('an agent sets the milestone up from the CLI: plan link, three waves, tasks in them', async () => {
  await signInAsAdmin(page);
  await api(page.request, 'POST', '/projects', project);
  const apiKey = await addAgent(page, agentName, [project.key]);
  const login = cli.run(['login', '--key', apiKey, '--url', baseURL, '--json']);
  expect(login.code, login.stdout + login.stderr).toBe(0);

  const flag = ['--project', project.key];
  const milestone = zamu<{ id: string; waves: unknown }>(
    ['milestones', 'create', milestoneName, ...flag],
    'zamu.v1.milestones.create',
  );
  milestoneId = milestone.id;
  zamu(['milestones', 'create', 'Maintenance', ...flag], 'zamu.v1.milestones.create');
  const linked = zamu<{ planUrl: string | null }>(
    ['milestones', 'update', milestoneName, '--plan', planPath, ...flag],
    'zamu.v1.milestones.update',
  );
  expect(linked.planUrl).toBe(planPath);

  for (const [index, wave] of waves.entries()) {
    const added = zamu<WaveShape>(
      ['waves', 'add', milestoneName, wave.name, '--gate', wave.gate, ...flag],
      'zamu.v1.wave',
    );
    expect(added).toMatchObject({ number: index + 1, name: wave.name, gate: { description: wave.gate } });
  }
  for (const title of titles) {
    zamu(['tasks', 'create', title, '--milestone', milestoneName, ...flag], 'zamu.v1.tasks.create');
  }
  const put: [string, string[]][] = [
    ['W1', ['STL-1', 'STL-2']],
    ['Screens', ['STL-3', 'STL-4']],
    ['3', ['STL-5']],
  ];
  for (const [wave, keys] of put) {
    zamu(['waves', 'put', milestoneName, wave, ...keys, ...flag], 'zamu.v1.milestone-plan');
  }

  const plan = await planOf();
  expect(plan.planUrl).toBe(planPath);
  expect(
    plan.waves.map((wave) => ({
      number: wave.number,
      current: wave.current,
      locked: wave.locked,
      until: wave.lockedUntil?.number ?? null,
      tasks: wave.tasks.map((task) => task.key).sort(),
    })),
  ).toEqual([
    { number: 1, current: true, locked: false, until: null, tasks: ['STL-1', 'STL-2'] },
    { number: 2, current: false, locked: true, until: 1, tasks: ['STL-3', 'STL-4'] },
    { number: 3, current: false, locked: true, until: 1, tasks: ['STL-5'] },
  ]);
  expect(plan.notInWave.map((task) => task.key)).toEqual(['STL-6']);
  expect((await taskOf('STL-4')).wave).toMatchObject({ number: 2, name: 'Screens', locked: true });
});

test('zamu milestones show prints the plan, the locks and what comes next', async () => {
  const text = zamuText(['milestones', 'show', milestoneName, '--project', project.key]);
  expect(text).toContain(`${milestoneName}  ${project.key} · Planned · 0 of 6 done`);
  expect(text).toContain(`Plan  ${planPath}`);
  expect(text).toContain('W1 · Data and contracts  0 of 2 done · gate open · current');
  expect(text).toContain(`  Gate: ${waves[0].gate}`);
  expect(text).toContain('W2 · Screens  0 of 2 done · gate open · locked until W1 passes');
  expect(text).toContain('W3 · End-to-end tests  0 of 1 done · gate open · locked (W1 has not passed)');
  expect(text).toMatch(/^ {2}STL-5 +Todo +Unassigned +Payout flow spec$/m);
  expect(text).toContain('Not in a wave  1 task · no gate');
  expect(text).toMatch(/^Next: W1 has 2 open tasks: STL-\d, STL-\d\. When they are done/m);

  const plan = zamu<PlanShape>(
    ['milestones', 'show', milestoneName, '--project', project.key],
    'zamu.v1.milestone-plan',
  );
  expect(plan.waves.map((wave) => wave.gate.state)).toEqual(['open', 'open', 'open']);

  // The list's WAVES column.
  const list = zamuText(['milestones', 'list', '--project', project.key]);
  expect(list).toMatch(/W1 of 3 · gate open +Payouts v2$/m);
});

test('an agent starting a task in W2 is refused with WAVE_LOCKED', async () => {
  const refused = cli.run(['tasks', 'update', 'STL-3', '--status', 'in_progress']);
  expect(refused.code, refused.stdout + refused.stderr).toBe(1);
  expect(refused.stderr).toContain(
    'STL-3 is in W2 · Screens, which is locked until W1 · Data and contracts passes.',
  );
  expect(refused.stderr).toContain(
    `The waves and their gates: zamu milestones show "${milestoneName}" --project ${project.key}`,
  );
  expect(refused.stderr).toContain("Don't take STL-3 out of its wave to get around the lock.");
  expect((await taskOf('STL-3')).status).toBe('todo');

  // The JSON answer is the problem, with the wave and the gate it waits for.
  const json = cli.run(['tasks', 'update', 'STL-3', '--status', 'in_review', '--json']);
  expect(json.code).toBe(1);
  expect(json.stdout + json.stderr).toContain('WAVE_LOCKED');
  expect((await taskOf('STL-3')).status).toBe('todo');
});

test('a person starting a W2 task gets the warning, cancels, then starts it anyway', async () => {
  await page.goto(w(`/p/${project.key}/STL-4`));
  await settle(page);
  const waveField = properties().getByRole('button', { name: 'Wave, W2 · Screens, locked' });
  await expect(waveField).toContainText('Locked until W1 passes');

  const status = properties().getByRole('button', { name: 'Status' });
  const warning = page.getByRole('alertdialog', { name: 'W2 is still locked' });
  const pickInProgress = async () => {
    await status.click();
    await page
      .getByRole('menu', { name: 'Status' })
      .getByRole('menuitemradio', { name: 'In progress' })
      .click();
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(
      'The gate of W1 · Data and contracts hasn’t passed yet. Starting STL-4 now works ahead of the plan',
    );
    await expect(warning).toContainText('Agents can’t start tasks in a locked wave.');
  };

  // Cancel keeps the status.
  await pickInProgress();
  await warning.getByRole('button', { name: 'Cancel' }).click();
  await expect(warning).toBeHidden();
  await expect(status).toContainText('Todo');
  expect((await taskOf('STL-4')).status).toBe('todo');

  // Start anyway starts it.
  await pickInProgress();
  await warning.getByRole('button', { name: /Start anyway/ }).click();
  await expect(warning).toBeHidden();
  await expect(status).toContainText('In progress');
  await expect.poll(async () => (await taskOf('STL-4')).status).toBe('in_progress');
  // The wave stays: starting ahead of the plan doesn't take the task out of it.
  expect((await taskOf('STL-4')).wave?.number).toBe(2);
});

test('the milestone page: Pass waits for W1’s tasks; the agent passes W1 from the CLI', async () => {
  await openMilestone();
  await expect(page.getByText(planPath, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy the plan link' })).toBeVisible();

  // W1 is current and open; W2 and W3 are locked and folded.
  await expect(waveHeader(1)).toHaveAttribute('data-current', 'true');
  await expect(waveHeader(1)).toContainText('Gate open');
  await expect(waveHeader(2)).toHaveAttribute('data-locked', 'true');
  await expect(waveHeader(2)).toContainText('Locked until W1 passes');
  await expect(waveHeader(3)).toHaveAttribute('data-locked', 'true');
  await expect(page.getByRole('button', { name: 'W2 · Screens', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(row('STL-1')).toBeVisible();
  await expect(row('STL-3')).toHaveCount(0);

  const gate = gateBox(1);
  await expect(gate).toContainText(waves[0].gate);
  await expect(gate.getByRole('button', { name: /^Pass/ })).toBeDisabled();
  await expect(gate).toContainText('Pass unlocks when the 2 open tasks are done');

  // The CLI refuses a pass with open tasks and names them.
  const early = cli.run(['waves', 'pass', milestoneName, 'W1', '--note', passNote, '--project', project.key]);
  expect(early.code, early.stdout + early.stderr).toBe(1);
  expect(early.stderr).toMatch(/W1 · Data and contracts has 2 open tasks: STL-\d, STL-\d\./);
  expect(early.stderr).toContain('A fail can be recorded at any time.');

  // One task done: one left.
  zamu(['tasks', 'update', 'STL-1', '--status', 'done'], 'zamu.v1.tasks.update');
  await page.reload();
  await settle(page);
  await expect(gateBox(1)).toContainText('Pass unlocks when the open task is done');
  await expect(gateBox(1).getByRole('button', { name: /^Pass/ })).toBeDisabled();

  // Both done: Pass is ready.
  zamu(['tasks', 'update', 'STL-2', '--status', 'done'], 'zamu.v1.tasks.update');
  await page.reload();
  await settle(page);
  await expect(gateBox(1).getByRole('button', { name: /^Pass/ })).toBeEnabled();
  await expect(gateBox(1)).not.toContainText('Pass unlocks');

  const passed = zamu<{ result: { state: string; note: string }; wave: WaveShape }>(
    ['waves', 'pass', milestoneName, 'W1', '--note', passNote, '--project', project.key],
    'zamu.v1.gate-result',
  );
  expect(passed.result).toMatchObject({ state: 'passed', note: passNote });
  expect(passed.wave.gate.result?.recordedBy.name).toBe(agentName);
  expect(passed.wave.gate.result?.onBehalfOf?.name).toBe(person);

  // W2 unlocks and becomes the current wave; W1 folds with its pill.
  await page.reload();
  await settle(page);
  await expect(waveHeader(1)).toContainText('Gate passed');
  await expect(waveHeader(2)).toHaveAttribute('data-current', 'true');
  await expect(waveHeader(2)).not.toHaveAttribute('data-locked', /.*/);
  await expect(waveHeader(3)).toContainText('Locked until W2 passes');
  await expect(row('STL-3')).toBeVisible();
  await expect(gateBox(2).getByRole('button', { name: /^Pass/ })).toBeDisabled();

  // The passed gate keeps who recorded it, for whom, and the note.
  await page.getByRole('button', { name: 'W1 · Data and contracts', exact: true }).click();
  // The page names the person by first name, as the design does ("claude-dev for Ana").
  await expect(gateBox(1)).toContainText(`Passed · ${agentName} for ${person.split(' ')[0]}, just now`);
  await expect(gateBox(1)).toContainText(passNote);
  await expect(gateBox(1).getByRole('button', { name: /Record again/ })).toBeVisible();

  // The task view: STL-3's wave is no longer locked.
  expect((await taskOf('STL-3')).wave).toMatchObject({ number: 2, locked: false });
});

test('a failed gate on W2: recorded from the page, the stop line goes across the top', async () => {
  await openMilestone();
  const gate = gateBox(2);
  await gate.getByRole('button', { name: 'Fail', exact: true }).click();
  const popover = page.getByRole('dialog', { name: 'Gate of W2 · Screens' });
  await expect(popover).toBeVisible();
  const note = popover.getByRole('textbox', { name: 'Note' });
  await expect(note).toBeFocused();
  // Passed can't be picked while tasks are open; the step says what a failure does.
  await expect(popover).toContainText('Pass unlocks when the 2 open tasks are done');
  await expect(popover).toContainText('W3 stays locked');

  // Record with no note asks for one.
  await popover.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(popover).toContainText('Write what was checked: the note is the evidence for the result.');
  await note.fill(failNote);
  await popover.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(popover).toBeHidden();
  await expect(toast('Recorded a failure for W2 · Screens')).toBeVisible();

  const stop = page.getByRole('note').filter({ hasText: 'The gate of W2 · Screens failed.' });
  await expect(stop).toBeVisible();
  await expect(stop).toContainText('The plan stops here: W3 stays locked until it passes.');
  await expect(waveHeader(2)).toContainText('Gate failed');
  await expect(gate).toContainText(`Failed · ${person}`);
  await expect(gate).toContainText(failNote);

  // Go to the gate focuses the failed gate's box.
  await stop.getByRole('button', { name: 'Go to the gate' }).click();
  await expect(gate).toBeFocused();

  // The record survives a reload, and the CLI reads the same.
  await page.reload();
  await settle(page);
  await expect(page.getByRole('note').filter({ hasText: 'The gate of W2 · Screens failed.' })).toBeVisible();
  const plan = await planOf();
  expect(plan.waves.map((wave) => wave.gate.state)).toEqual(['passed', 'failed', 'open']);
  expect(plan.waves[2]).toMatchObject({ locked: true, lockedUntil: { number: 2 } });
  const text = zamuText(['milestones', 'show', milestoneName, '--project', project.key]);
  expect(text).toContain('W2 · Screens  0 of 2 done · gate failed · current');
  expect(text).toMatch(new RegExp(`Failed by ${person}, \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}: ${failNote}`));
  expect(text).toContain("Next: W2's gate failed.");
});

test('Alt+↓ and Alt+↑ move a task to the next wave and back', async () => {
  await openMilestone();
  await expect(row('STL-3')).toBeVisible();
  await focusRow('STL-3');

  await page.keyboard.down('Alt');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('status').filter({ hasText: 'Moving STL-3 to W3' })).toBeVisible();
  await page.keyboard.up('Alt');
  await expect(toast('Moved STL-3 to W3 · End-to-end tests')).toBeVisible();
  await expect.poll(async () => (await taskOf('STL-3')).wave?.number).toBe(3);
  // W3 opens to show where the task went.
  await expect(row('STL-3')).toBeVisible();
  await expect(waveHeader(3)).toContainText('0 of 2');

  await focusRow('STL-3');
  await page.keyboard.down('Alt');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('status').filter({ hasText: 'Moving STL-3 to W2' })).toBeVisible();
  await page.keyboard.up('Alt');
  await expect(toast('Moved STL-3 to W2 · Screens')).toBeVisible();
  await expect.poll(async () => (await taskOf('STL-3')).wave?.number).toBe(2);

  // Esc while the hint shows cancels the move.
  await focusRow('STL-3');
  await page.keyboard.down('Alt');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('status').filter({ hasText: 'Moving STL-3 to W3' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.up('Alt');
  await expect(page.getByRole('status').filter({ hasText: 'Moving STL-3' })).toHaveCount(0);
  expect((await taskOf('STL-3')).wave?.number).toBe(2);
});

test('the milestone list shows each milestone’s wave status', async () => {
  await page.goto(w(`/p/${project.key}/milestones`));
  await settle(page);
  const list = page.getByRole('list', { name: `Open milestones of ${project.name}` });
  const milestoneRow = (name: string) =>
    list.getByRole('listitem').filter({ has: page.getByRole('link', { name, exact: true }) });
  await expect(milestoneRow(milestoneName).locator('[data-part="wave-status"]')).toHaveText(
    'Gate failed in wave 2 of 3',
  );
  await expect(milestoneRow(milestoneName).locator('[data-part="wave-status"]')).toHaveAttribute(
    'data-state',
    'failed',
  );
  await expect(milestoneRow('Maintenance').locator('[data-part="wave-status"]')).toHaveText('No waves');

  // Passing W2 again (tasks done) moves the line on to W3.
  for (const key of ['STL-3', 'STL-4']) {
    zamu(['tasks', 'update', key, '--status', 'done'], 'zamu.v1.tasks.update');
  }
  zamu(
    [
      'waves',
      'pass',
      milestoneName,
      'W2',
      '--note',
      'Both screens checked in light and dark.',
      '--project',
      project.key,
    ],
    'zamu.v1.gate-result',
  );
  await page.reload();
  await settle(page);
  await expect(milestoneRow(milestoneName).locator('[data-part="wave-status"]')).toHaveText(
    'Wave 3 of 3 · gate open',
  );
});

test('the milestone page in the dark theme', async () => {
  await openMilestone();
  const lightBackground = await luminance('section[aria-label="Milestone"]');
  await testInfoAttach('milestone page, light');

  await api(page.request, 'PATCH', '/me', { theme: 'dark' });
  await page.reload();
  await settle(page);
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect(page.getByRole('heading', { level: 1, name: milestoneName })).toBeVisible();
  await expect(page.getByText(planPath, { exact: true })).toBeVisible();
  await expect(waveHeader(2)).toContainText('Gate passed');
  await expect(waveHeader(3)).toHaveAttribute('data-current', 'true');
  await expect(gateBox(3)).toContainText(waves[2].gate);
  await expect(row('STL-5')).toBeVisible();
  const darkBackground = await luminance('section[aria-label="Milestone"]');
  expect(lightBackground).toBeGreaterThan(0.5);
  expect(darkBackground).toBeLessThan(0.1);
  await testInfoAttach('milestone page, dark');

  await api(page.request, 'PATCH', '/me', { theme: 'system' });
});

test('no page errors during the flow', () => {
  expect(pageErrors).toEqual([]);
});

/** Attaches a screenshot of the page to the running test's report. */
async function testInfoAttach(name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}
