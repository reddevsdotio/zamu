// TanStack Start server functions for Backlog.md setup and the Backlog.md section of project settings
// (M3), and the switch of a mirrored project to Zamu (M6). Settings-only data, so the screens call @zamu/core through these thin adapters: validate with
// the contract schema, build the actor from the request in the page's workspace, call core, return a SettingsResult (unwrap
// it in the browser with `unwrap` from features/settings/result). Product data (tasks, the status a
// header shows) stays on /api/v1: GET /projects/{project}/backlog is `orpc.backlog.status`.
// Handler bodies (and the server-only imports they use) are stripped from the client bundle.

import { createServerFn } from '@tanstack/react-start';
import {
  BacklogProjectInput,
  BacklogWebhookInfoInput,
  CreateProjectFromBacklogInput,
  DetachBacklogInput,
  DetectBacklogInput,
  DetectBacklogRepositoryInput,
  PreviewBacklogInput,
  RefreshBacklogNowInput,
  ReissueBacklogWebhookSecretInput,
  SetBacklogConnectionInput,
  SetBacklogFolderInput,
  StartBacklogInput,
  UpdateBacklogMappingsInput,
} from '@zamu/contracts';
import {
  checkBacklogSwitch,
  createProjectFromBacklog,
  detectBacklog,
  detectBacklogRepository,
  getBacklogSettingsStatus,
  getBacklogWebhookInfo,
  previewBacklog,
  refreshBacklogNow,
  reissueBacklogWebhookSecret,
  setBacklogConnection,
  setBacklogFolder,
  startBacklog,
  switchBacklogToZamu,
  updateBacklogMappings,
} from '@zamu/core';
import { inWorkspace, runInWorkspace as run } from '../../lib/server-fn';

// ---------------------------------------------------------------------------
// Setup (five steps) and New project from Backlog.md
// ---------------------------------------------------------------------------

/**
 * Step 2: default branch, head, folder (override, backlog.config.yml, backlog/, .backlog/), config
 * summary, file counts, access, prefilled mappings. Reads the repository; writes nothing.
 * -> BacklogDetection
 */
export const detectBacklogFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(DetectBacklogInput))
  .handler(({ data }) => run(data.workspace, (core, actor) => detectBacklog(core, actor, data.input)));

/** Step 4: a dry run of the first read with the mappings. Writes nothing. -> BacklogPreview */
export const previewBacklogFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(PreviewBacklogInput))
  .handler(({ data }) => run(data.workspace, (core, actor) => previewBacklog(core, actor, data.input)));

/**
 * Step 5: creates the source, turns milestones on and queues the first read (an import detaches
 * after it). PROJECT_NOT_EMPTY when the project has tasks. -> BacklogSourceStatus
 */
export const startBacklogFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(StartBacklogInput))
  .handler(({ data }) => run(data.workspace, (core, actor) => startBacklog(core, actor, data.input)));

/**
 * New project from Backlog.md, before the project exists: the step 2 read on the pasted repository,
 * so the dialog can prefill name and key from config.yml. Writes nothing. -> BacklogDetection
 */
export const detectBacklogRepositoryFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(DetectBacklogRepositoryInput))
  .handler(({ data }) =>
    run(data.workspace, (core, actor) => detectBacklogRepository(core, actor, data.input)),
  );

/** Creates the project for "New project from Backlog.md"; setup continues at Mappings. -> Project */
export const createProjectFromBacklogFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(CreateProjectFromBacklogInput))
  .handler(({ data }) =>
    run(data.workspace, (core, actor) => createProjectFromBacklog(core, actor, data.input)),
  );

// ---------------------------------------------------------------------------
// Project settings: Backlog.md section
// ---------------------------------------------------------------------------

/** The source as the settings page shows it (the first page of problems). -> BacklogSourceStatus */
export const backlogSettingsStatusFn = createServerFn({ method: 'GET' })
  .validator(inWorkspace(BacklogProjectInput))
  .handler(({ data }) =>
    run(data.workspace, (core, actor) => getBacklogSettingsStatus(core, actor, data.input)),
  );

/** New mappings, applied to every task on the next refresh. -> BacklogSourceStatus */
export const updateBacklogMappingsFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(UpdateBacklogMappingsInput))
  .handler(({ data }) =>
    run(data.workspace, (core, actor) => updateBacklogMappings(core, actor, data.input)),
  );

/** Sets the folder by hand; null goes back to detecting it. -> BacklogSourceStatus */
export const setBacklogFolderFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(SetBacklogFolderInput))
  .handler(({ data }) => run(data.workspace, (core, actor) => setBacklogFolder(core, actor, data.input)));

/** Reads through another connection (a paused mirror whose connection was deleted). -> BacklogSourceStatus */
export const setBacklogConnectionFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(SetBacklogConnectionInput))
  .handler(({ data }) => run(data.workspace, (core, actor) => setBacklogConnection(core, actor, data.input)));

/** Refresh now (trigger manual). BACKLOG_PAUSED or BACKLOG_DETACHED when it cannot. -> BacklogRefreshResult */
export const refreshBacklogNowFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(RefreshBacklogNowInput))
  .handler(({ data }) => run(data.workspace, (core, actor) => refreshBacklogNow(core, actor, data.input)));

/**
 * The webhook URL (always), the secret (owners and admins; null for others and after detach), the
 * provider and the last delivery. The webhook dialog polls it. -> BacklogWebhookInfo
 */
export const backlogWebhookInfoFn = createServerFn({ method: 'GET' })
  .validator(inWorkspace(BacklogWebhookInfoInput))
  .handler(({ data }) =>
    run(data.workspace, (core, actor) => getBacklogWebhookInfo(core, actor, data.input)),
  );

/**
 * A new webhook secret for a mirror (owners and admins); the URL stays. The old secret stops working
 * at once. Callers keep the secret out of the query cache. -> BacklogWebhookSecret
 */
export const reissueBacklogWebhookSecretFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(ReissueBacklogWebhookSecretInput))
  .handler(({ data }) =>
    run(data.workspace, (core, actor) => reissueBacklogWebhookSecret(core, actor, data.input)),
  );

// ---------------------------------------------------------------------------
// Project settings: the switch to Zamu (M6)
// ---------------------------------------------------------------------------

/**
 * The check before the switch: the open pull or merge requests that change files in the Backlog.md
 * folder, or `ok: false` with the reason when the host could not answer. Reads the host; writes nothing.
 * Owners and admins. -> BacklogSwitchCheck
 */
export const checkBacklogSwitchFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(BacklogProjectInput))
  .handler(({ data }) => run(data.workspace, (core, actor) => checkBacklogSwitch(core, actor, data.input)));

/**
 * Switches a mirrored project to Zamu for good after the typed key: the mirror stops and every task
 * becomes editable here. Owners and admins. -> BacklogSwitchResult (when, by whom, the new status)
 */
export const switchBacklogToZamuFn = createServerFn({ method: 'POST' })
  .validator(inWorkspace(DetachBacklogInput))
  .handler(({ data }) => run(data.workspace, (core, actor) => switchBacklogToZamu(core, actor, data.input)));
