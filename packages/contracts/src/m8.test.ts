// M8 contract additions: the plan link on milestones, waves with their gates and recorded results,
// the lock on tasks, the milestone plan and the wave summary, the wave change in history, the two
// new problem codes, the routes and the CLI shapes for them.

import { ORPCError } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { CLI_INSTRUCTION_TOPICS, cliOutput, parseCliOutput } from './cli';
import { apiErrors, contract } from './contract';
import {
  Activity,
  ActivityChange,
  GateResult,
  Milestone,
  MilestonePlan,
  MilestoneWaveSummary,
  MilestoneWithProgress,
  Task,
  TaskListItem,
  TimelineItem,
  Wave,
  WaveGate,
} from './entities';
import {
  CreateTaskInput,
  CreateWaveInput,
  DeleteWaveInput,
  GateDescription,
  GateNote,
  GetMilestonePlanInput,
  MAX_BULK_TASKS,
  PlanUrl,
  PutTasksInWaveInput,
  RecordGateInput,
  UpdateMilestoneInput,
  UpdateTaskInput,
  UpdateWaveInput,
  WaveName,
  WavePosition,
} from './inputs';
import {
  formatWaveNumber,
  GATE_RESULT_STATES,
  GATE_STATE_LABELS,
  GATE_STATES,
  MAX_GATE_DESCRIPTION_LENGTH,
  MAX_GATE_NOTE_LENGTH,
  MAX_PLAN_URL_LENGTH,
  MAX_WAVE_NAME_LENGTH,
  MAX_WAVE_OPEN_KEYS,
  parseWaveReference,
  planUrlKind,
} from './primitives';
import { PROBLEM_STATUS, PROBLEM_TITLES, Problem, ProblemData, problem } from './problem';
import { decodeProblem, encodeProblem } from './problem-codec';
import {
  currentWaveFixture,
  failedWaveFixture,
  lockedWaveFixture,
  milestoneFixture,
  milestonePlanFixture,
  milestoneWithProgressFixture,
  passedWaveFixture,
  payoutsMilestoneFixture,
  payoutsMilestoneId,
  taskFixture,
  taskListItemFixture,
  waveActivityFixture,
  waveIds,
  waveTaskFixture,
} from './testing/fixtures';

const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

const firstMessage = (result: { error?: { issues: { message: string }[] } }) =>
  result.error?.issues[0]?.message;

/** The input schema of a contract procedure. */
function input(procedure: { '~orpc': { inputSchema?: unknown } }): z.ZodType {
  return procedure['~orpc'].inputSchema as z.ZodType;
}

describe('M8 primitives', () => {
  it('names the limits, the gate states and their labels', () => {
    expect([
      MAX_PLAN_URL_LENGTH,
      MAX_WAVE_NAME_LENGTH,
      MAX_GATE_DESCRIPTION_LENGTH,
      MAX_GATE_NOTE_LENGTH,
    ]).toEqual([2_000, 100, 4_000, 10_000]);
    expect(MAX_WAVE_OPEN_KEYS).toBe(50);
    expect(GATE_STATES).toEqual(['open', 'passed', 'failed']);
    expect(GATE_RESULT_STATES).toEqual(['passed', 'failed']);
    expect(GATE_STATE_LABELS).toEqual({ open: 'Open', passed: 'Passed', failed: 'Failed' });
  });

  it('numbers waves W1, W2 and reads a wave reference as a number or a name', () => {
    expect(formatWaveNumber(3)).toBe('W3');
    expect(parseWaveReference('3')).toEqual({ kind: 'number', number: 3 });
    expect(parseWaveReference('W3')).toEqual({ kind: 'number', number: 3 });
    expect(parseWaveReference(' w12 ')).toEqual({ kind: 'number', number: 12 });
    expect(parseWaveReference('Payout screens')).toEqual({ kind: 'name', name: 'Payout screens' });
    // Zero, leading zeros and other shapes are names.
    for (const value of ['0', 'W0', '03', 'W3a', 'Wave 3'])
      expect(parseWaveReference(value).kind, value).toBe('name');
  });
});

describe('plan link (call 1)', () => {
  it('shows web addresses as links and anything else as a path', () => {
    expect(planUrlKind('https://wiki.northwind.dev/plans/payouts-v2')).toBe('link');
    expect(planUrlKind('http://wiki.northwind.dev/plans/payouts-v2')).toBe('link');
    expect(planUrlKind('HTTPS://wiki.northwind.dev/x')).toBe('link');
    expect(planUrlKind('plans/payouts-v2.html')).toBe('path');
    expect(planUrlKind('/home/ana/plans/payouts-v2.md')).toBe('path');
    expect(planUrlKind('ftp://files.northwind.dev/plan.md')).toBe('path');
    expect(planUrlKind('wiki.northwind.dev/plans')).toBe('path');
  });

  it('takes one trimmed line of 1 to 2,000 characters', () => {
    expect(PlanUrl.parse('  plans/payouts-v2.html  ')).toBe('plans/payouts-v2.html');
    expect(PlanUrl.safeParse('x'.repeat(2_000)).success).toBe(true);
    expect(firstMessage(PlanUrl.safeParse('x'.repeat(2_001)))).toBe('Keep it to 2,000 characters or fewer');
    expect(firstMessage(PlanUrl.safeParse('   '))).toBe('Add a link or a path to the plan');
    expect(firstMessage(PlanUrl.safeParse('plans/a.html\nplans/b.html'))).toBe('Keep it on one line');
    expect(PlanUrl.safeParse('plans/a.html\r').success, 'trailing line breaks trim away').toBe(true);
  });

  it('sets and clears it on PATCH /milestones/{id}, alone or with other changes', () => {
    const id = payoutsMilestoneId;
    expect(UpdateMilestoneInput.parse({ id, planUrl: ' https://wiki.northwind.dev/p ' })).toEqual({
      id,
      planUrl: 'https://wiki.northwind.dev/p',
    });
    expect(UpdateMilestoneInput.parse({ id, planUrl: null })).toEqual({ id, planUrl: null });
    expect(UpdateMilestoneInput.safeParse({ id, name: 'Payouts', planUrl: 'plans/p.md' }).success).toBe(true);
    expect(issuePaths(UpdateMilestoneInput.safeParse({ id, planUrl: '' }))).toEqual(['planUrl']);
    expect(firstMessage(UpdateMilestoneInput.safeParse({ id }))).toBe(
      'Change at least one of name, description, targetDate, status or planUrl',
    );
    expect(input(contract.milestones.update).safeParse({ id, planUrl: null }).success).toBe(true);
  });

  it('reads back on milestones, missing reading as none', () => {
    expect(Milestone.parse(milestoneFixture).planUrl).toBeUndefined();
    expect(Milestone.parse({ ...milestoneFixture, planUrl: null }).planUrl).toBeNull();
    expect(MilestoneWithProgress.parse(payoutsMilestoneFixture).planUrl).toBe('plans/payouts-v2.html');
  });
});

describe('waves', () => {
  it('names a wave with one trimmed line of 1 to 100 characters', () => {
    expect(WaveName.parse('  Payout screens ')).toBe('Payout screens');
    expect(WaveName.safeParse('x'.repeat(100)).success).toBe(true);
    expect(firstMessage(WaveName.safeParse('x'.repeat(101)))).toBe('Keep it to 100 characters or fewer');
    expect(firstMessage(WaveName.safeParse(' '))).toBe('Name the wave');
    expect(firstMessage(WaveName.safeParse('Data\nand contracts'))).toBe('Keep it on one line');
  });

  it('keeps the gate description as Markdown up to 4,000 characters, blank as none', () => {
    expect(GateDescription.parse('- Tests pass\n- Both themes\n')).toBe('- Tests pass\n- Both themes\n');
    expect(GateDescription.parse('  \n ')).toBeNull();
    expect(GateDescription.safeParse('x'.repeat(4_000)).success).toBe(true);
    expect(firstMessage(GateDescription.safeParse('x'.repeat(4_001)))).toBe(
      'Keep it to 4,000 characters or fewer',
    );
  });

  it('places a wave from 1, in whole numbers', () => {
    expect(WavePosition.parse(1)).toBe(1);
    for (const value of [0, -1, 1.5, '2'])
      expect(WavePosition.safeParse(value).success, String(value)).toBe(false);
  });

  it('adds a wave on POST /milestones/{milestone}/waves', () => {
    const create = input(contract.waves.create);
    expect(create.parse({ milestone: payoutsMilestoneId, name: ' Rollout ' })).toEqual({
      milestone: payoutsMilestoneId,
      name: 'Rollout',
    });
    expect(
      CreateWaveInput.parse({
        milestone: payoutsMilestoneId,
        name: 'Rollout',
        gateDescription: 'Flag on for 10% of merchants',
        position: 2,
      }),
    ).toMatchObject({ gateDescription: 'Flag on for 10% of merchants', position: 2 });
    expect(
      CreateWaveInput.parse({ milestone: payoutsMilestoneId, name: 'R', gateDescription: ' ' }),
    ).toMatchObject({
      gateDescription: null,
    });
    expect(issuePaths(CreateWaveInput.safeParse({ milestone: payoutsMilestoneId }))).toEqual(['name']);
    expect(issuePaths(CreateWaveInput.safeParse({ milestone: 'm-3', name: 'R' }))).toEqual(['milestone']);
  });

  it('renames, describes and moves a wave on PATCH /waves/{id}', () => {
    const update = input(contract.waves.update);
    const id = waveIds.w3;
    expect(update.parse({ id, name: 'Screens' })).toEqual({ id, name: 'Screens' });
    expect(UpdateWaveInput.parse({ id, gateDescription: null })).toEqual({ id, gateDescription: null });
    expect(UpdateWaveInput.parse({ id, position: 1 })).toEqual({ id, position: 1 });
    expect(firstMessage(UpdateWaveInput.safeParse({ id }))).toBe(
      'Change at least one of name, gateDescription or position',
    );
    expect(UpdateWaveInput.safeParse({ id, position: 0 }).success).toBe(false);
  });

  it('removes a wave on DELETE /waves/{id} and reads the plan on GET /milestones/{id}/plan', () => {
    expect(input(contract.waves.delete).parse({ id: waveIds.w4 })).toEqual({ id: waveIds.w4 });
    expect(DeleteWaveInput.safeParse({ id: 'W4' }).success).toBe(false);
    expect(input(contract.milestones.plan).parse({ id: payoutsMilestoneId })).toEqual({
      id: payoutsMilestoneId,
    });
    expect(GetMilestonePlanInput.safeParse({}).success).toBe(false);
  });

  it('puts tasks in a wave, or out of one, on POST /milestones/{milestone}/wave-tasks', () => {
    const put = input(contract.waves.putTasks);
    expect(
      put.parse({ milestone: payoutsMilestoneId, wave: waveIds.w4, keys: ['pay-174', 'PAY-174', 'PAY-180'] }),
    ).toEqual({
      milestone: payoutsMilestoneId,
      wave: waveIds.w4,
      keys: ['PAY-174', 'PAY-180'],
    });
    expect(
      PutTasksInWaveInput.parse({ milestone: payoutsMilestoneId, wave: null, keys: ['PAY-174'] }).wave,
    ).toBeNull();
    // The wave is required: null takes the tasks out, nothing is not an answer.
    expect(
      issuePaths(PutTasksInWaveInput.safeParse({ milestone: payoutsMilestoneId, keys: ['PAY-174'] })),
    ).toEqual(['wave']);
    expect(
      firstMessage(PutTasksInWaveInput.safeParse({ milestone: payoutsMilestoneId, wave: null, keys: [] })),
    ).toBe('Pick at least one task');
    const tooMany = Array.from({ length: MAX_BULK_TASKS + 1 }, (_, index) => `PAY-${index + 1}`);
    expect(
      firstMessage(
        PutTasksInWaveInput.safeParse({ milestone: payoutsMilestoneId, wave: null, keys: tooMany }),
      ),
    ).toBe('Change 100 tasks or fewer at once');
  });

  it('records a gate result with a note on POST /waves/{id}/gate', () => {
    const record = input(contract.waves.recordGate);
    expect(record.parse({ id: waveIds.w3, state: 'passed', note: '  Ran the suite: 412 passed.  ' })).toEqual(
      {
        id: waveIds.w3,
        state: 'passed',
        note: 'Ran the suite: 412 passed.',
      },
    );
    expect(
      RecordGateInput.safeParse({ id: waveIds.w3, state: 'failed', note: 'Banner overlaps.' }).success,
    ).toBe(true);
    // Open is a state, not a result: there is no way back to it.
    expect(issuePaths(RecordGateInput.safeParse({ id: waveIds.w3, state: 'open', note: 'x' }))).toEqual([
      'state',
    ]);
    expect(issuePaths(RecordGateInput.safeParse({ id: waveIds.w3, state: 'passed' }))).toEqual(['note']);
  });

  it('needs a gate note of 1 to 10,000 characters', () => {
    expect(firstMessage(GateNote.safeParse('  \n'))).toBe('Say what was checked');
    expect(GateNote.safeParse('x'.repeat(10_000)).success).toBe(true);
    expect(firstMessage(GateNote.safeParse('x'.repeat(10_001)))).toBe(
      'Keep it to 10,000 characters or fewer',
    );
    expect(GateNote.parse('**Checked**\n\n- light\n- dark')).toBe('**Checked**\n\n- light\n- dark');
  });

  it('declares every new route with its method, status and tag', () => {
    expect(contract.waves.create['~orpc'].route).toMatchObject({
      method: 'POST',
      successStatus: 201,
      tags: ['waves'],
    });
    expect(contract.waves.delete['~orpc'].route).toMatchObject({ method: 'DELETE', successStatus: 204 });
    expect(contract.waves.putTasks['~orpc'].route.successStatus).toBeUndefined();
    expect(contract.waves.recordGate['~orpc'].route.successStatus).toBeUndefined();
    expect(contract.milestones.plan['~orpc'].route).toMatchObject({ method: 'GET', tags: ['milestones'] });
  });
});

describe('waves on tasks', () => {
  it('puts a task in a wave or takes it out on PATCH /tasks/{key}', () => {
    expect(UpdateTaskInput.parse({ key: 'PAY-174', wave: waveIds.w4 })).toEqual({
      key: 'PAY-174',
      wave: waveIds.w4,
    });
    expect(UpdateTaskInput.parse({ key: 'PAY-174', wave: null })).toEqual({ key: 'PAY-174', wave: null });
    expect(UpdateTaskInput.safeParse({ key: 'PAY-174', wave: 'W4' }).success).toBe(false);
    expect(
      UpdateTaskInput.safeParse({ key: 'PAY-174', status: 'in_progress', wave: waveIds.w4 }).success,
    ).toBe(true);
    expect(input(contract.tasks.update).safeParse({ key: 'PAY-174', wave: null }).success).toBe(true);
  });

  it('may start a new task in a wave', () => {
    expect(CreateTaskInput.parse({ project: 'PAY', title: 'Banner copy', wave: waveIds.w3 }).wave).toBe(
      waveIds.w3,
    );
    expect(CreateTaskInput.parse({ project: 'PAY', title: 'Banner copy' }).wave).toBeUndefined();
  });

  it('carries the wave and its lock on tasks and rows, missing reading as none', () => {
    expect(Task.parse(waveTaskFixture).wave).toEqual({
      id: waveIds.w4,
      number: 4,
      name: 'Rollout',
      locked: true,
      lockedUntil: { number: 3, name: 'Payout screens' },
    });
    expect(Task.parse(taskFixture).wave).toBeUndefined();
    expect(TaskListItem.parse({ ...taskListItemFixture, wave: waveTaskFixture.wave }).wave?.number).toBe(4);
    expect(TaskListItem.parse(taskListItemFixture).wave).toBeUndefined();
    expect(TaskListItem.parse({ ...taskListItemFixture, wave: null }).wave).toBeNull();
  });
});

describe('gates and the plan', () => {
  it('reads each wave state: passed, current with its gate open, locked, failed', () => {
    const passed = Wave.parse(passedWaveFixture);
    expect(passed.gate.result).toMatchObject({
      state: 'passed',
      recordedBy: { name: 'claude-dev' },
      onBehalfOf: { name: 'Ana Ruiz' },
      at: '2026-11-24T16:00:00.000Z',
      source: { machine: 'ana-mbp', branch: 'feat/ledger' },
    });
    expect(Wave.parse(currentWaveFixture)).toMatchObject({ current: true, locked: false, canPass: false });
    expect(Wave.parse(lockedWaveFixture)).toMatchObject({ locked: true, lockedUntil: { number: 3 } });
    expect(Wave.parse(failedWaveFixture).gate).toMatchObject({
      state: 'failed',
      result: { onBehalfOf: null },
    });
  });

  it('keeps the gate state equal to its latest result, open without one', () => {
    const result = passedWaveFixture.gate.result;
    expect(WaveGate.safeParse({ description: null, state: 'open', result: null }).success).toBe(true);
    expect(WaveGate.safeParse({ description: null, state: 'passed', result: null }).success).toBe(false);
    expect(WaveGate.safeParse({ description: null, state: 'failed', result }).success).toBe(false);
    expect(WaveGate.safeParse({ description: null, state: 'open', result }).success).toBe(false);
  });

  it('needs a note on every result, and source is optional', () => {
    const { source: _source, ...withoutSource } = passedWaveFixture.gate.result;
    expect(GateResult.parse(withoutSource).source).toBeUndefined();
    expect(GateResult.safeParse({ ...withoutSource, note: '' }).success).toBe(false);
    expect(GateResult.safeParse({ ...withoutSource, state: 'open' }).success).toBe(false);
  });

  it('lists at most 50 open keys on a wave', () => {
    const keys = Array.from({ length: 51 }, (_, index) => `PAY-${index + 1}`);
    expect(Wave.safeParse({ ...currentWaveFixture, openKeys: keys }).success).toBe(false);
    expect(Wave.safeParse({ ...currentWaveFixture, openKeys: keys.slice(0, 50) }).success).toBe(true);
  });

  it('returns the milestone, the link, the waves and the tasks in no wave', () => {
    const plan = MilestonePlan.parse(milestonePlanFixture);
    expect(plan.planUrl).toBe('plans/payouts-v2.html');
    expect(plan.waves.map((wave) => [wave.number, wave.gate.state, wave.locked])).toEqual([
      [2, 'passed', false],
      [3, 'open', false],
      [4, 'open', true],
    ]);
    expect(plan.notInWave.map((task) => task.key)).toEqual(['PAY-190']);
    expect(plan.milestone.waves).toEqual({ count: 5, current: 3, currentState: 'open', allPassed: false });
  });

  it('summarises the waves of a milestone for the list, null without waves', () => {
    expect(MilestoneWithProgress.parse(milestoneWithProgressFixture).waves).toBeUndefined();
    expect(MilestoneWithProgress.parse({ ...milestoneWithProgressFixture, waves: null }).waves).toBeNull();
    expect(
      MilestoneWaveSummary.parse({ count: 12, current: 8, currentState: 'failed', allPassed: false }),
    ).toEqual({
      count: 12,
      current: 8,
      currentState: 'failed',
      allPassed: false,
    });
    expect(
      MilestoneWaveSummary.safeParse({ count: 4, current: null, currentState: null, allPassed: true })
        .success,
    ).toBe(true);
    // Inconsistent summaries are refused.
    for (const value of [
      { count: 4, current: null, currentState: null, allPassed: false },
      { count: 4, current: 2, currentState: null, allPassed: false },
      { count: 4, current: 2, currentState: 'open', allPassed: true },
      { count: 4, current: 5, currentState: 'open', allPassed: false },
      { count: 0, current: null, currentState: null, allPassed: true },
      { count: 4, current: 2, currentState: 'passed', allPassed: false },
    ]) {
      expect(MilestoneWaveSummary.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe('the wave change in history', () => {
  it('records moves between waves, into one and out of one, with a removed wave named as such', () => {
    const entry = Activity.parse(waveActivityFixture);
    expect(entry.changes).toEqual([
      {
        field: 'wave',
        from: { id: waveIds.w3, number: 3, name: 'Payout screens', removed: false },
        to: { id: waveIds.w4, number: 4, name: 'Rollout', removed: false },
      },
    ]);
    const removed = { id: waveIds.w5, number: 5, name: 'Cleanup', removed: true };
    expect(ActivityChange.parse({ field: 'wave', from: removed, to: null })).toEqual({
      field: 'wave',
      from: removed,
      to: null,
    });
    expect(
      ActivityChange.safeParse({ field: 'wave', from: null, to: { id: waveIds.w1, number: 1 } }).success,
    ).toBe(false);
    expect(ActivityChange.safeParse({ field: 'wave', from: null, to: 'W1' }).success).toBe(false);
  });

  it('puts a task in a wave of another milestone with both changes in one row', () => {
    const entry = Activity.parse({
      ...waveActivityFixture,
      changes: [
        { field: 'milestone', from: null, to: { id: payoutsMilestoneId, name: 'Payouts v2' } },
        {
          field: 'wave',
          from: null,
          to: { id: waveIds.w3, number: 3, name: 'Payout screens', removed: false },
        },
      ],
    });
    expect(entry.changes.map((change) => change.field)).toEqual(['milestone', 'wave']);
    expect(TimelineItem.parse({ ...waveActivityFixture, kind: 'activity' }).kind).toBe('activity');
  });
});

describe('M8 problems', () => {
  it('declares WAVE_LOCKED and GATE_TASKS_OPEN as 409s with titles', () => {
    expect({
      WAVE_LOCKED: PROBLEM_STATUS.WAVE_LOCKED,
      GATE_TASKS_OPEN: PROBLEM_STATUS.GATE_TASKS_OPEN,
    }).toEqual({
      WAVE_LOCKED: 409,
      GATE_TASKS_OPEN: 409,
    });
    expect(PROBLEM_TITLES.WAVE_LOCKED).toBe('Wave is locked');
    expect(PROBLEM_TITLES.GATE_TASKS_OPEN).toBe('Wave has open tasks');
    for (const code of ['WAVE_LOCKED', 'GATE_TASKS_OPEN'] as const) {
      expect(apiErrors[code].status, code).toBe(409);
      expect(Problem.parse(problem(code, 'detail'))).toMatchObject({ code, status: 409 });
    }
  });

  it('carries the lock and its hint with WAVE_LOCKED through encode and decode', () => {
    const waveLock = {
      task: 'PAY-174',
      wave: { number: 4, name: 'Rollout' },
      waitsFor: { number: 3, name: 'Payout screens' },
    };
    const error = new ORPCError('WAVE_LOCKED', {
      status: 409,
      message: 'PAY-174 is in W4, which is locked until W3 passes.',
      data: { waveLock, hint: 'zamu milestones show "Payouts v2"' },
    });
    const encoded = encodeProblem(error);
    expect(encoded).toMatchObject({
      code: 'WAVE_LOCKED',
      status: 409,
      waveLock,
      hint: 'zamu milestones show "Payouts v2"',
    });
    expect(Problem.parse(encoded).waveLock).toEqual(waveLock);
    const decoded = decodeProblem(encoded);
    expect(decoded?.code).toBe('WAVE_LOCKED');
    expect(decoded?.data).toMatchObject({ waveLock, hint: 'zamu milestones show "Payouts v2"' });
    expect(problem('WAVE_LOCKED', 'locked', { waveLock }).waveLock).toEqual(waveLock);
    expect(ProblemData.safeParse({ waveLock: { ...waveLock, waitsFor: null } }).success).toBe(false);
  });

  it('lists the open keys with GATE_TASKS_OPEN through encode and decode', () => {
    const error = new ORPCError('GATE_TASKS_OPEN', {
      status: 409,
      message: 'W3 has 2 open tasks: PAY-173 and PAY-174.',
      data: { openKeys: ['PAY-173', 'PAY-174'] },
    });
    const encoded = encodeProblem(error);
    expect(encoded).toMatchObject({ code: 'GATE_TASKS_OPEN', openKeys: ['PAY-173', 'PAY-174'] });
    expect(decodeProblem(encoded)?.data.openKeys).toEqual(['PAY-173', 'PAY-174']);
    expect(encodeProblem(new ORPCError('GATE_TASKS_OPEN', { status: 409 }))).not.toHaveProperty('openKeys');
    expect(encodeProblem(new ORPCError('WAVE_LOCKED', { status: 409 }))).not.toHaveProperty('waveLock');
    expect(ProblemData.safeParse({ openKeys: [] }).success).toBe(false);
    expect(
      ProblemData.safeParse({ openKeys: Array.from({ length: 51 }, (_, i) => `PAY-${i + 1}`) }).success,
    ).toBe(false);
  });
});

describe('M8 CLI output', () => {
  it('prints zamu milestones show and zamu waves put as zamu.v1.milestone-plan', () => {
    const shown = cliOutput('milestone-plan', milestonePlanFixture);
    expect(shown.schema).toBe('zamu.v1.milestone-plan');
    expect(shown.data.waves[0]?.gate.result?.at).toBe('2026-11-24T16:00:00.000Z');
    expect(parseCliOutput(JSON.parse(JSON.stringify(shown)), 'milestone-plan').data.planUrl).toBe(
      'plans/payouts-v2.html',
    );
  });

  it('prints zamu waves add and update as zamu.v1.wave, and remove as zamu.v1.wave-removed', () => {
    expect(cliOutput('wave', lockedWaveFixture)).toMatchObject({
      schema: 'zamu.v1.wave',
      data: { number: 4, lockedUntil: { number: 3 } },
    });
    expect(
      cliOutput('wave-removed', {
        milestoneId: payoutsMilestoneId,
        removed: { id: waveIds.w4, number: 4, name: 'Rollout' },
        tasks: ['PAY-180', 'PAY-181'],
      }),
    ).toEqual({
      schema: 'zamu.v1.wave-removed',
      data: {
        milestoneId: payoutsMilestoneId,
        removed: { id: waveIds.w4, number: 4, name: 'Rollout' },
        tasks: ['PAY-180', 'PAY-181'],
      },
    });
  });

  it('prints zamu waves pass and fail as zamu.v1.gate-result', () => {
    const recorded = cliOutput('gate-result', {
      result: failedWaveFixture.gate.result,
      wave: failedWaveFixture,
    });
    expect(recorded.schema).toBe('zamu.v1.gate-result');
    expect(recorded.data.result).toMatchObject({ state: 'failed', recordedBy: { name: 'Tomás Berg' } });
    expect(() => cliOutput('gate-result', { result: failedWaveFixture.gate.result } as never)).toThrow();
  });

  it('carries the wave in zamu.v1.tasks.* and the plan link in milestones results', () => {
    expect(
      cliOutput('tasks.show', { task: waveTaskFixture, activity: [waveActivityFixture] }).data.task.wave,
    ).toMatchObject({ number: 4, locked: true });
    expect(cliOutput('tasks.update', waveTaskFixture).data.wave?.lockedUntil).toEqual({
      number: 3,
      name: 'Payout screens',
    });
    expect(cliOutput('milestones.update', payoutsMilestoneFixture).data).toMatchObject({
      planUrl: 'plans/payouts-v2.html',
      waves: { current: 3 },
    });
    expect(
      cliOutput('milestones.list', { items: [milestoneWithProgressFixture] }).data.items[0]?.waves,
    ).toBeUndefined();
  });

  it('adds the planning topic to zamu instructions', () => {
    expect(CLI_INSTRUCTION_TOPICS).toEqual(['overview', 'creating', 'working', 'finishing', 'planning']);
    expect(
      cliOutput('instructions', { topic: 'planning', text: 'Set the plan link first.' }).data.topic,
    ).toBe('planning');
  });
});
