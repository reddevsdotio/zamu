// Runs helm-chart.ts the way the release workflow does, with node, against a fake helm-charts clone in a
// temporary directory: the bump, re-runs, older and malformed versions, the README row and --dry-run.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'helm-chart.ts');

const CHART = `# The official chart for Zamu.
apiVersion: v2
name: zamu
description: Project management for teams where AI coding agents work next to people
type: application
# Bumped by the Zamu release workflow.
version: 0.1.0
appVersion: "0.12.0" # the image tag
dependencies: []
`;

const README = `# Helm charts

| Chart                  | Version | App Version | Description            |
| ---------------------- | ------- | ----------- | ---------------------- |
| [ghost](charts/ghost)  | 1.6.0   | 5-alpine    | Ghost blogging platform |
| [zamu](charts/zamu)    | 0.1.0   | 0.12.0      | Zamu project management |
`;

let dir: string;

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const chart = () => readFileSync(join(dir, 'charts/zamu/Chart.yaml'), 'utf8');
const readme = () => readFileSync(join(dir, 'README.md'), 'utf8');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'helm-chart-'));
  mkdirSync(join(dir, 'charts/zamu'), { recursive: true });
  writeFileSync(join(dir, 'charts/zamu/Chart.yaml'), CHART);
  writeFileSync(join(dir, 'README.md'), README);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('helm-chart.ts', () => {
  it('sets appVersion, bumps the chart patch and keeps every other line', () => {
    const result = run('--version', '0.13.0', '--dir', dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('charts/zamu 0.1.1 now runs Zamu 0.13.0');
    expect(chart()).toBe(
      CHART.replace('version: 0.1.0', 'version: 0.1.1').replace(
        'appVersion: "0.12.0"',
        'appVersion: "0.13.0"',
      ),
    );
  });

  it('updates the zamu row of the README and leaves the other rows alone', () => {
    expect(run('--version', '0.13.0', '--dir', dir).status).toBe(0);
    expect(readme()).toBe(
      README.replace(
        '| [zamu](charts/zamu)    | 0.1.0   | 0.12.0      |',
        '| [zamu](charts/zamu)    | 0.1.1   | 0.13.0      |',
      ),
    );
  });

  it('changes nothing when run again with the same version', () => {
    expect(run('--version', '0.13.0', '--dir', dir).status).toBe(0);
    const [chartAfter, readmeAfter] = [chart(), readme()];
    const again = run('--version', '0.13.0', '--dir', dir);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('already at Zamu 0.13.0');
    expect(chart()).toBe(chartAfter);
    expect(readme()).toBe(readmeAfter);
  });

  it('never moves the chart back to an older version', () => {
    const result = run('--version', '0.11.4', '--dir', dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('newer than that: at Zamu 0.12.0');
    expect(chart()).toBe(CHART);
    expect(readme()).toBe(README);
  });

  it('compares versions as numbers, not as text', () => {
    expect(run('--version', '0.9.0', '--dir', dir).stdout).toContain('nothing to change');
    expect(run('--version', '0.12.10', '--dir', dir).status).toBe(0);
    expect(chart()).toContain('appVersion: "0.12.10"');
  });

  it.each(['', '0.13', 'v0.13.0', '0.13.0-rc.1', '0.13.0 '])('refuses the version "%s"', (version) => {
    const result = run('--version', version, '--dir', dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--version needs X.Y.Z');
    expect(chart()).toBe(CHART);
  });

  it('refuses a clone without the zamu row in the README', () => {
    writeFileSync(join(dir, 'README.md'), '# Helm charts\n');
    const result = run('--version', '0.13.0', '--dir', dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('table row, found 0');
    expect(chart()).toBe(CHART);
  });

  it('prints a diff with --dry-run and writes nothing', () => {
    const result = run('--version', '0.13.0', '--dir', dir, '--dry-run');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--- a/charts/zamu/Chart.yaml');
    expect(result.stdout).toContain('-version: 0.1.0\n+version: 0.1.1');
    expect(result.stdout).toContain(
      '-appVersion: "0.12.0" # the image tag\n+appVersion: "0.13.0" # the image tag',
    );
    expect(result.stdout).toContain('+++ b/README.md');
    expect(result.stdout).toContain('nothing written');
    expect(chart()).toBe(CHART);
    expect(readme()).toBe(README);
  });
});
