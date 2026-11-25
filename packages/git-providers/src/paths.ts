import { GitNotFound } from './errors';

/**
 * Repository path segments. GitHub and Gitea take exactly `owner/name`; GitLab takes a namespace path
 * of two or more segments. Anything else cannot exist on the provider, so it is a GitNotFound.
 */
export function repoSegments(path: string, nested: boolean): string[] {
  const segments = path.replace(/^\/+|\/+$/g, '').split('/');
  const valid =
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
    (nested ? segments.length >= 2 : segments.length === 2);
  if (!valid) throw new GitNotFound(`"${path}" is not a repository path.`);
  return segments;
}

/**
 * Folder path relative to the repository root, without leading or trailing slashes; '' is the root.
 * Throws RangeError for `.` or `..` segments: callers validate folder overrides before this point.
 */
export function normalizeFolder(folder: string): string {
  const trimmed = folder
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/^\/+|\/+$/g, '');
  if (trimmed === '' || trimmed === '.') return '';
  const segments = trimmed.split(/\/+/);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new RangeError(`Folder "${folder}" must not contain . or .. segments.`);
  }
  return segments.join('/');
}

/** Parent folder and name of a file path. */
export function splitFilePath(filePath: string): { parent: string; name: string } {
  const normalized = normalizeFolder(filePath);
  const index = normalized.lastIndexOf('/');
  return index === -1
    ? { parent: '', name: normalized }
    : { parent: normalized.slice(0, index), name: normalized.slice(index + 1) };
}

/** Git file modes that are not regular file content: symlinks and submodules. */
export function isRegularFileMode(mode: unknown): boolean {
  return mode !== '120000' && mode !== '160000';
}

/** True when `filePath` is `folder` itself or sits below it ('' holds every path). */
export function isUnderFolder(filePath: string, folder: string): boolean {
  const normalized = normalizeFolder(folder);
  if (normalized === '') return true;
  const file = filePath.replace(/^\/+/, '');
  return file === normalized || file.startsWith(`${normalized}/`);
}
