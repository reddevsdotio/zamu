// Builds the folder that is published to npm as @reddevs/zamu: the bundle with the release version baked in,
// the README, the licence and a package.json written from scratch. The workspace package (@zamu/cli) is never
// published as it is: its package.json names workspace packages and build tools that users must not get.
//
// The dependency list comes from the bundle itself: every package the built code still imports at runtime,
// at the exact version apps/cli/package.json pins. Workspace packages are bundled, so none can appear.
//
//   node apps/cli/scripts/npm-package.ts --version 0.9.0 [--out DIR] [--check]
//
// --check packs the folder, installs the tarball into an empty directory and runs `zamu --version` there.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** The name on npm. The workspace package keeps @zamu/cli. */
const PUBLISHED_NAME = '@reddevs/zamu';
const REPOSITORY = 'reddevsdotio/zamu';
const BIN = 'zamu';

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_DIR = resolve(CLI_DIR, '../..');
const RELEASE_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const PINNED = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

interface WorkspaceManifest {
  description?: string;
  license?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function fail(message: string): never {
  console.error(`npm-package: ${message}`);
  process.exit(1);
}

/** `@orpc/openapi-client/fetch` -> `@orpc/openapi-client`, `zod/v4` -> `zod`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** The npm packages a set of bundle imports needs; built-ins and the bundle's own chunks are left out. */
function runtimePackages(imports: Iterable<string>): string[] {
  const names = new Set<string>();
  for (const specifier of imports) {
    if (isBuiltin(specifier) || specifier.startsWith('.') || specifier.startsWith('/')) continue;
    names.add(packageName(specifier));
  }
  return [...names].sort();
}

/** The published package.json. Throws when a runtime import has no exact pinned version. */
function publishedManifest(
  version: string,
  workspace: WorkspaceManifest,
  imports: readonly string[],
): Record<string, unknown> {
  const dependencies: Record<string, string> = {};
  for (const name of imports) {
    if (name.startsWith('@zamu/')) throw new Error(`the bundle imports the workspace package ${name}`);
    const pinned = workspace.dependencies?.[name];
    if (!pinned) throw new Error(`the bundle imports ${name}, which is not in the dependencies of apps/cli`);
    if (!PINNED.test(pinned)) throw new Error(`${name} must be pinned to an exact version, not ${pinned}`);
    dependencies[name] = pinned;
  }
  return {
    name: PUBLISHED_NAME,
    version,
    description:
      'Command-line client for Zamu, the self-hosted project management tool for teams that work with AI coding agents',
    keywords: ['zamu', 'cli', 'project-management', 'ai-agents', 'tasks'],
    license: workspace.license ?? 'MIT',
    homepage: `https://github.com/${REPOSITORY}#readme`,
    bugs: { url: `https://github.com/${REPOSITORY}/issues` },
    repository: { type: 'git', url: `git+https://github.com/${REPOSITORY}.git`, directory: 'apps/cli' },
    type: 'module',
    bin: { [BIN]: 'dist/index.js' },
    files: ['dist'],
    engines: workspace.engines ?? { node: '>=24.0.0' },
    dependencies,
    publishConfig: { access: 'public' },
  };
}

async function buildBundle(
  version: string,
  outDir: string,
): Promise<{ imports: string[]; inlined: string[] }> {
  // tsdown.config.ts reads this to set the version the bundle prints.
  process.env.ZAMU_CLI_VERSION = version;
  const { build } = await import('tsdown');
  const handle = await build({
    config: join(CLI_DIR, 'tsdown.config.ts'),
    cwd: CLI_DIR,
    outDir,
    logLevel: 'warn',
  });
  const imports = new Set<string>();
  const inlined = new Set<string>();
  for (const bundle of handle.bundles) {
    for (const chunk of bundle.chunks) {
      if (chunk.type !== 'chunk') continue;
      for (const specifier of [...chunk.imports, ...chunk.dynamicImports]) imports.add(specifier);
    }
    for (const name of bundle.inlinedDeps.keys()) inlined.add(name);
  }
  return { imports: [...imports], inlined: [...inlined].sort() };
}

/** Packs the folder, installs the tarball into an empty directory and checks what it pulls in and prints. */
function check(folder: string, version: string, workspace: WorkspaceManifest): void {
  const scratch = mkdtempSync(join(tmpdir(), 'zamu-npm-check-'));
  try {
    const packed = execFileSync('npm', ['pack', folder, '--pack-destination', scratch, '--json'], {
      encoding: 'utf8',
    });
    const [info] = JSON.parse(packed) as { filename: string; files: { path: string }[] }[];
    if (!info) fail('npm pack printed nothing');
    const tarball = join(scratch, info.filename);
    console.log(`packed ${info.filename}: ${info.files.map((file) => file.path).join(', ')}`);

    const prefix = join(scratch, 'install');
    mkdirSync(prefix);
    writeFileSync(join(prefix, 'package.json'), '{"private":true}\n');
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--omit=dev', tarball], {
      cwd: prefix,
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    const installed = installedPackages(join(prefix, 'node_modules'));
    const forbidden = installed.filter(
      (name) => name.startsWith('@zamu/') || Object.hasOwn(workspace.devDependencies ?? {}, name),
    );
    if (forbidden.length > 0) fail(`the install pulled in ${forbidden.join(', ')}`);

    const printed = execFileSync(join(prefix, 'node_modules', '.bin', BIN), ['--version'], {
      encoding: 'utf8',
    }).trim();
    if (printed !== version) fail(`zamu --version printed "${printed}", expected "${version}"`);
    console.log(`installed ${installed.length} packages; zamu --version prints ${printed}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function installedPackages(nodeModules: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(join(nodeModules, entry.name))) names.push(`${entry.name}/${scoped}`);
    } else {
      names.push(entry.name);
    }
  }
  return names.sort();
}

async function run(): Promise<void> {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      out: { type: 'string' },
      check: { type: 'boolean', default: false },
    },
  });
  const version = values.version ?? '';
  if (!RELEASE_VERSION.test(version))
    fail(`--version needs a release version such as 0.9.0, got "${version}"`);
  const folder = resolve(values.out ?? join(CLI_DIR, 'dist', 'npm'));

  const workspace = JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf8')) as WorkspaceManifest;
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });

  const { imports, inlined } = await buildBundle(version, join(folder, 'dist'));
  const runtime = runtimePackages(imports);
  let manifest: Record<string, unknown>;
  try {
    manifest = publishedManifest(version, workspace, runtime);
  } catch (error) {
    fail((error as Error).message);
  }
  const unused = Object.keys(workspace.dependencies ?? {}).filter((name) => !runtime.includes(name));
  if (unused.length > 0) console.log(`left out (bundled or unused): ${unused.join(', ')}`);
  console.log(`bundled from node_modules: ${inlined.length > 0 ? inlined.join(', ') : 'nothing'}`);
  console.log(`runtime dependencies: ${runtime.join(', ')}`);

  writeFileSync(join(folder, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  cpSync(join(CLI_DIR, 'README.md'), join(folder, 'README.md'));
  cpSync(join(ROOT_DIR, 'LICENSE'), join(folder, 'LICENSE'));
  console.log(`${PUBLISHED_NAME}@${version} ready in ${folder}`);

  if (values.check) check(folder, version, workspace);
}

await run();
