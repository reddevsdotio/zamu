// Writes the Homebrew formula (Formula/zamu.rb in the reddevsdotio/homebrew-tap repository) from
// docker/homebrew/zamu.rb.template: the address of the npm tarball and its sha256. Homebrew reads the version
// from the tarball's file name, so the script checks that the name ends in -<version>.tgz.
//
//   node apps/cli/scripts/homebrew-formula.ts --version 0.9.0 --url URL --sha256 HEX --out Formula/zamu.rb
//
// URL is https://registry.npmjs.org/@reddevs/zamu/-/zamu-<version>.tgz in a release, or a file:// address
// of an `npm pack` tarball to try the formula locally.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const TEMPLATE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docker/homebrew/zamu.rb.template',
);

function fail(message: string): never {
  console.error(`homebrew-formula: ${message}`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    url: { type: 'string' },
    sha256: { type: 'string' },
    out: { type: 'string' },
  },
});
const { version = '', url = '', sha256 = '', out } = values;

if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`--version needs X.Y.Z, got "${version}"`);
if (!/^(https|file):\/\/\S+$/.test(url)) fail(`--url needs an https:// or file:// address, got "${url}"`);
if (!url.endsWith(`-${version}.tgz`)) fail(`the tarball name must end in -${version}.tgz: ${url}`);
if (!/^[0-9a-f]{64}$/.test(sha256)) fail(`--sha256 needs 64 lowercase hex characters, got "${sha256}"`);
if (!out) fail('--out needs the path of the formula to write');

const formula = readFileSync(TEMPLATE, 'utf8').replaceAll('@URL@', url).replaceAll('@SHA256@', sha256);
const leftover = formula.match(/@[A-Z0-9_]+@/);
if (leftover) fail(`the template has a placeholder this script does not fill: ${leftover[0]}`);

mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(out, formula);
console.log(`wrote ${out} for zamu ${version}`);
