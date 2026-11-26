// Keys for what the browser remembers per workspace (localStorage and sessionStorage): the List / Board
// choice, display options, collapsed board columns, the task view's J / K list, setup picks. Project and
// task keys repeat across workspaces (Acme and Globex can both have PAY), so every key carries the
// workspace id, which stays the same when the slug changes. Values stored before 0.10 (keys without a
// workspace) are not read: the version in the key moved to v2, and those choices start over once.
//
//   workspaceStorageKey('display', workspaceId, userId, 'PAY', 'board')
//     -> zamu:display:v2:<workspace id>:<user id>:PAY:board

/** Version of the per-workspace key format. */
export const STORAGE_KEY_VERSION = 'v2';

/** `zamu:<name>:v2:` — every key of `name` starts with it (storage events filter on it). */
export function storageKeyPrefix(name: string): string {
  return `zamu:${name}:${STORAGE_KEY_VERSION}:`;
}

/** `zamu:<name>:v2:<workspace id>:<part>:<part>…` */
export function workspaceStorageKey(name: string, workspaceId: string, ...parts: readonly string[]): string {
  return [`${storageKeyPrefix(name)}${workspaceId}`, ...parts].join(':');
}
