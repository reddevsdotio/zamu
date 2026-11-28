// Points the official Helm chart (charts/zamu in a clone of reddevsdotio/helm-charts) at a Zamu release:
// sets appVersion in Chart.yaml, which is also the image tag the chart runs, bumps the chart's own version by
// a patch, and updates the zamu row of the README's chart table. The release workflow runs it and opens a pull
// request with the result.
//
//   node apps/cli/scripts/helm-chart.ts --version 0.13.0 --dir ../helm-charts [--dry-run]
//
// Edits are line by line: comments and every other line of both files stay as they are. A version equal to or
// older than the chart's appVersion changes nothing, so a re-run or a patch on an older line never moves the
// chart backwards. --dry-run prints the changes as a diff and writes nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const CHART = 'charts/zamu/Chart.yaml';
const README = 'README.md';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
/** A top-level key, its value with optional quotes, and what follows (spaces, a comment). */
const KEY_LINE = (key: string) => new RegExp(`^(${key}:\\s*)(["']?)([^"'\\s#]*)\\2(\\s*(?:#.*)?)$`);
const README_ROW = /^\|\s*\[zamu\]\(charts\/zamu\/?\)\s*\|/;

function fail(message: string): never {
  console.error(`helm-chart: ${message}`);
  process.exit(1);
}

function parse(version: string): [number, number, number] | undefined {
  const match = SEMVER.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Splits a file into lines and the line ending it uses, so it can be joined back byte for byte. */
function lines(text: string): { lines: string[]; eol: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { lines: text.split(eol), eol };
}

/** The index of the one top-level line for `key`; fails when there is none or more than one. */
function keyLine(fileLines: string[], key: string): { index: number; match: RegExpExecArray } {
  const pattern = KEY_LINE(key);
  const found = fileLines.flatMap((line, index) => {
    const match = pattern.exec(line);
    return match ? [{ index, match }] : [];
  });
  if (found.length !== 1) fail(`${CHART} needs exactly one top-level "${key}:" line, found ${found.length}`);
  return found[0] as { index: number; match: RegExpExecArray };
}

/** Replaces a cell's text and keeps the spaces around it. */
function setCell(cell: string, value: string): string {
  const text = cell.trim();
  if (!text) return ` ${value} `;
  const start = cell.indexOf(text);
  return cell.slice(0, start) + value + cell.slice(start + text.length);
}

interface Change {
  file: string;
  line: number;
  before: string;
  after: string;
}

function printDiff(changes: Change[]): void {
  for (const file of new Set(changes.map((change) => change.file))) {
    console.log(`--- a/${file}`);
    console.log(`+++ b/${file}`);
    for (const change of changes.filter((c) => c.file === file)) {
      console.log(`@@ -${change.line + 1} +${change.line + 1} @@`);
      console.log(`-${change.before}`);
      console.log(`+${change.after}`);
    }
  }
}

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    dir: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const { version = '', dir, 'dry-run': dryRun } = values;

const target = parse(version);
if (!target) fail(`--version needs X.Y.Z, got "${version}"`);
if (!dir) fail('--dir needs the path of a reddevsdotio/helm-charts clone');

const chartPath = join(dir, CHART);
const readmePath = join(dir, README);
let chartText: string;
let readmeText: string;
try {
  chartText = readFileSync(chartPath, 'utf8');
  readmeText = readFileSync(readmePath, 'utf8');
} catch (error) {
  fail(`cannot read the chart: ${(error as Error).message}`);
}

const chart = lines(chartText);
const app = keyLine(chart.lines, 'appVersion');
const current = parse(app.match[3] ?? '');
if (!current) fail(`${CHART} has appVersion "${app.match[3]}", which is not X.Y.Z`);
if (compare(current, target) >= 0) {
  const relation = compare(current, target) === 0 ? 'already' : 'newer than that:';
  console.log(`charts/zamu is ${relation} at Zamu ${app.match[3]}; nothing to change for ${version}`);
  process.exit(0);
}

const chartVersionLine = keyLine(chart.lines, 'version');
const chartVersion = parse(chartVersionLine.match[3] ?? '');
if (!chartVersion) fail(`${CHART} has version "${chartVersionLine.match[3]}", which is not X.Y.Z`);
const nextChartVersion = `${chartVersion[0]}.${chartVersion[1]}.${chartVersion[2] + 1}`;

const readme = lines(readmeText);
const rows = readme.lines.flatMap((line, index) => (README_ROW.test(line) ? [index] : []));
if (rows.length !== 1)
  fail(`${README} needs exactly one "| [zamu](charts/zamu) |" table row, found ${rows.length}`);
const rowIndex = rows[0] as number;
const cells = (readme.lines[rowIndex] as string).split('|');
// "| chart | version | app version | description |" splits into ['', chart, version, app, description, ''].
if (cells.length < 6)
  fail(`the zamu row of ${README} does not have the Chart, Version and App Version columns`);
cells[2] = setCell(cells[2] as string, nextChartVersion);
cells[3] = setCell(cells[3] as string, version);

const changes: Change[] = [];
function change(file: string, fileLines: string[], index: number, after: string): void {
  const before = fileLines[index] as string;
  if (before === after) return;
  changes.push({ file, line: index, before, after });
  fileLines[index] = after;
}
const [, versionKey, versionQuote, , versionRest] = chartVersionLine.match;
change(
  CHART,
  chart.lines,
  chartVersionLine.index,
  `${versionKey}${versionQuote}${nextChartVersion}${versionQuote}${versionRest}`,
);
const [, appKey, , , appRest] = app.match;
change(CHART, chart.lines, app.index, `${appKey}"${version}"${appRest}`);
change(README, readme.lines, rowIndex, cells.join('|'));

if (dryRun) {
  printDiff(changes);
  console.log(`dry run: charts/zamu ${nextChartVersion} for Zamu ${version}; nothing written`);
  process.exit(0);
}

writeFileSync(chartPath, chart.lines.join(chart.eol));
writeFileSync(readmePath, readme.lines.join(readme.eol));
console.log(`charts/zamu ${nextChartVersion} now runs Zamu ${version}`);
