import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type {
  BacklogMappingsView,
  BacklogMode,
  BacklogSourceStatus,
  ProjectWithCounts,
} from '@zamu/contracts';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { startBacklogFn, updateBacklogMappingsFn } from '~/features/backlog/server';
import { useSubmitHint } from '~/features/projects/NewProjectDialog';
import { errorMessage, SettingsError, unwrap } from '~/features/settings/result';
import { projectHref } from '~/features/shell/paths';
import { useApi, useWorkspaceId, useWorkspaceSlug } from '~/lib/workspace';
import { Banner, Button, EmptyState, type SetupStep, Skeleton, useHotkeys } from '~/ui';
import { type AgentSuggestion, assignAgent } from './agent-suggestions';
import type { InviteDraft } from './assignee-hints';
import { CreateAgentHost } from './CreateAgentHost';
import { pickConnection } from './connections';
import { InviteHost } from './InviteHost';
import { MappingsEditor } from './MappingsStep';
import { ModeStep } from './ModeStep';
import { forgetMappings, loadSavedMappings, saveMappings } from './mapping-memory';
import { applyManualPicks, mappingValueCount, toMappings } from './mappings';
import { NewFromBacklogDialogHost } from './NewFromBacklogDialogHost';
import { PreviewStep, previewTotal } from './PreviewStep';
import { DetailBox, type SetupFooterProps, SetupFrame, TextLink, useContinueShortcut } from './parts';
import { backlogWebhookHref, projectSettingsHref } from './paths';
import { readPhase, readTotal } from './phase';
import {
  connectionsQuery,
  detectionQuery,
  membersQuery,
  previewQuery,
  projectsQuery,
  projectTaskCountQuery,
  setupQueryKey,
  sourceStatusQuery,
} from './queries';
import { ReadStep } from './ReadStep';
import { SourceStep } from './SourceStep';
import { SETUP_STEP_LABELS, SETUP_STEPS, type SetupSearch, type SetupStepId, stepIndex } from './search';

// The Backlog.md setup route (frames 3a to 3p): Mode, Source, Mappings, Preview, Read. Nothing is written
// before Start. ⌘↵ continues, Esc cancels. With ?edit=1 it edits the mappings of an existing source.

export interface BacklogSetupScreenProps {
  projectKey: string;
  search: SetupSearch;
}

export function BacklogSetupScreen({ projectKey, search }: BacklogSetupScreenProps) {
  const api = useApi();
  const projects = useQuery(projectsQuery(api));
  const project = projects.data?.items.find((item) => item.key === projectKey);

  if (!project) {
    return (
      <section className="flex min-h-0 flex-1 flex-col" aria-label="Backlog.md setup">
        <div className="flex h-16 shrink-0 items-center border-b border-line px-6">
          {projects.isPending ? <Skeleton width={260} height={14} /> : null}
        </div>
        <div className="flex flex-1 items-center px-24">
          {projects.isPending ? null : projects.isError ? (
            <Banner
              action={
                <Button variant="secondary" size="sm" onPress={() => void projects.refetch()}>
                  Retry
                </Button>
              }
            >
              Couldn't load the project. Check your connection and try again.
            </Banner>
          ) : (
            <EmptyState
              title={`No project ${projectKey}`}
              text="It may have been renamed, or you may not have access to it."
            />
          )}
        </div>
      </section>
    );
  }

  return search.edit ? <EditMappings project={project} /> : <SetupWizard project={project} search={search} />;
}

function useSetSearch(projectKey: string) {
  const workspace = useWorkspaceSlug();
  const navigate = useNavigate();
  return (patch: Partial<Record<keyof SetupSearch, unknown>>, options: { replace?: boolean } = {}) =>
    void navigate({
      to: '/w/$workspace/p/$projectKey/backlog-setup',
      params: { workspace, projectKey },
      search: (previous: SetupSearch) => {
        const next: Record<string, unknown> = { ...previous, ...patch };
        for (const name of Object.keys(next)) if (next[name] === undefined) delete next[name];
        return next as SetupSearch;
      },
      replace: options.replace ?? false,
    });
}

const n = (value: number) => value.toLocaleString('en-US');

// ---------------------------------------------------------------------------
// Five steps
// ---------------------------------------------------------------------------

function SetupWizard({ project, search }: { project: ProjectWithCounts; search: SetupSearch }) {
  const workspace = useWorkspaceSlug();
  const workspaceId = useWorkspaceId();
  const api = useApi();
  const projectKey = project.key;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setSearch = useSetSearch(projectKey);
  const submitHint = useSubmitHint();
  const settingsHref = projectSettingsHref(workspace, projectKey);
  const [newFromOpen, setNewFromOpen] = useState(false);

  const mode: BacklogMode = search.mode ?? 'mirror';
  const status = useQuery(sourceStatusQuery(api, projectKey));
  const hasSource = status.isSuccess;
  const noSource = status.error instanceof SettingsError && status.error.code === 'NOT_FOUND';
  const requested = search.step ?? 'mode';
  const step: SetupStepId = hasSource ? 'read' : requested === 'read' ? 'mode' : requested;
  const beforeStart = !hasSource;

  const taskCount = useQuery({
    ...projectTaskCountQuery(api, projectKey),
    enabled: step === 'mode' && noSource,
  });

  const needsSource = step === 'source' || step === 'mappings' || step === 'preview';
  const connections = useQuery({ ...connectionsQuery(api), enabled: needsSource && beforeStart });
  const connectionId =
    search.connection ??
    (connections.data ? (pickConnection(connections.data.items, project.repository)?.id ?? null) : null);
  const detection = useQuery({
    ...detectionQuery(api, { projectKey, connectionId: connectionId ?? '', folderOverride: search.folder }),
    enabled: needsSource && beforeStart && Boolean(connectionId && project.repository),
  });
  const detected = detection.data;
  const detectionUsable = Boolean(
    detected && detected.access === 'ok' && detected.folder && !detected.configError && detected.config,
  );

  // Mappings: detected rows, plus picks made by hand (also kept in session storage for reloads).
  const detectKey = `${connectionId ?? ''}|${search.folder ?? ''}`;
  const [edited, setEdited] = useState<{ key: string; view: BacklogMappingsView } | null>(null);
  const prefilled = useMemo(
    () =>
      detected?.mappings
        ? applyManualPicks(detected.mappings, loadSavedMappings(workspaceId, projectKey))
        : null,
    [detected, workspaceId, projectKey],
  );
  const mappings = edited?.key === detectKey ? edited.view : prefilled;
  const onMappingsChange = (view: BacklogMappingsView) => {
    setEdited({ key: detectKey, view });
    saveMappings(workspaceId, projectKey, toMappings(view));
  };
  const members = useQuery({ ...membersQuery(api), enabled: step === 'mappings' });
  const [agentDraft, setAgentDraft] = useState<AgentSuggestion | null>(null);
  const [inviteDraft, setInviteDraft] = useState<InviteDraft | null>(null);
  // Invitations made here (value to email). Screen state only: nothing maps on accept.
  const [invited, setInvited] = useState<Record<string, string>>({});

  const preview = useQuery({
    ...previewQuery(api, {
      projectKey,
      connectionId: connectionId ?? '',
      folderOverride: search.folder,
      mappings: mappings ? toMappings(mappings) : { status: [], priority: [], assignee: [] },
    }),
    enabled: step === 'preview' && beforeStart && Boolean(connectionId && mappings && detectionUsable),
  });

  // Mappings and Preview need a readable folder: go back to Source when detection says otherwise.
  useEffect(() => {
    if ((step === 'mappings' || step === 'preview') && beforeStart) {
      const noConnection = connections.isSuccess && !connectionId;
      if (noConnection || (detected && !detectionUsable)) setSearch({ step: 'source' }, { replace: true });
    }
  });

  const start = useMutation({
    mutationFn: () =>
      unwrap(
        startBacklogFn({
          data: {
            workspace: api.slug,
            input: {
              projectKey,
              connectionId: connectionId ?? '',
              mode,
              mappings: mappings ? toMappings(mappings) : { status: [], priority: [], assignee: [] },
              ...(search.folder ? { folderOverride: search.folder } : {}),
            },
          },
        }),
      ),
    onSuccess: (source: BacklogSourceStatus) => {
      forgetMappings(workspaceId, projectKey);
      queryClient.setQueryData(sourceStatusQuery(api, projectKey).queryKey, source);
      void queryClient.invalidateQueries({ queryKey: api.orpc.projects.key() });
      setSearch({ step: 'read', mode, connection: connectionId ?? undefined }, { replace: true });
    },
  });

  // When the first read ends, the project's tasks and header change.
  const phase = status.data ? readPhase(status.data) : null;
  useEffect(() => {
    if (phase && phase !== 'reading') {
      void queryClient.invalidateQueries({ queryKey: api.orpc.projects.key() });
      void queryClient.invalidateQueries({ queryKey: api.orpc.tasks.key() });
    }
  }, [phase, queryClient, api]);

  const openProject = () => void navigate({ href: projectHref(workspace, projectKey) });
  const cancel = () => void navigate({ href: settingsHref });
  const go = (next: SetupStepId) =>
    setSearch({
      step: next === 'mode' ? undefined : next,
      connection: next === 'mode' ? search.connection : (connectionId ?? undefined),
    });

  // Step list with notes on done steps: Mirror, backlog/, 13 values, 412 tasks.
  const source = status.data;
  const notes: Record<SetupStepId, ReactNode> = {
    mode: (source?.mode ?? mode) === 'import' ? 'Import' : 'Mirror',
    source: source?.folder ? `${source.folder}/` : detected?.folder ? `${detected.folder}/` : null,
    mappings: source
      ? `${n(mappingValueCount(source.mappings))} values`
      : mappings
        ? `${n(mappingValueCount(mappings))} values`
        : null,
    preview:
      source && phase === 'done'
        ? `${n(readTotal(source))} tasks`
        : preview.data
          ? `${n(previewTotal(preview.data))} tasks`
          : null,
    read: null,
  };
  const current = stepIndex(step);
  const done = phase === 'done';
  const steps: SetupStep[] = SETUP_STEPS.map((id, index) => {
    const state =
      index < current || (done && id === 'read') ? 'done' : index === current ? 'current' : 'todo';
    return {
      id,
      label: SETUP_STEP_LABELS[id],
      state,
      note: state === 'done' ? (notes[id] ?? undefined) : undefined,
    };
  });
  const navHint = done
    ? source?.mode === 'import'
      ? 'Done. The import is recorded in Settings → Backlog.md.'
      : 'Done. Mappings and the webhook can be changed in Settings → Backlog.md.'
    : `Step ${current + 1} of 5 · ${SETUP_STEP_LABELS[step]}`;

  // Footer and the body of the current step.
  let footer: SetupFooterProps;
  let body: ReactNode;
  if (status.isPending) {
    footer = {};
    body = <Skeleton height={120} />;
  } else if (status.isError && !noSource) {
    footer = {};
    body = (
      <Banner
        action={
          <Button variant="secondary" size="sm" onPress={() => void status.refetch()}>
            Retry
          </Button>
        }
      >
        {errorMessage(status.error)}
      </Banner>
    );
  } else if (step === 'mode') {
    const empty = taskCount.data === 0;
    footer = {
      hint: 'Nothing is written until the last step.',
      next: { label: 'Continue', kbd: submitHint, onPress: () => go('source'), isDisabled: !empty },
    };
    body = (
      <ModeStep
        projectKey={projectKey}
        projectName={project.name}
        mode={mode}
        onModeChange={(next) => setSearch({ mode: next }, { replace: true })}
        taskCount={taskCount.data}
        taskCountError={taskCount.isError}
        onRetry={() => void taskCount.refetch()}
        onNewFromBacklog={() => setNewFromOpen(true)}
        onBackToProject={openProject}
      />
    );
  } else if (step === 'source') {
    footer = {
      onBack: () => go('mode'),
      hint: 'Read access is enough.',
      next: {
        label: 'Continue',
        kbd: submitHint,
        onPress: () => go('mappings'),
        isDisabled: !detectionUsable,
      },
    };
    body = (
      <SourceStep
        projectKey={projectKey}
        projectName={project.name}
        repository={project.repository}
        settingsHref={settingsHref}
        connections={connections.data?.items}
        connectionsError={connections.error}
        encryptionReady={connections.data?.encryptionReady ?? true}
        connectionId={connectionId}
        onConnectionChange={(id) => setSearch({ connection: id }, { replace: true })}
        detection={detected}
        detectionPending={detection.isFetching && !detected}
        detectionError={detection.error}
        onRetryDetection={() => void detection.refetch()}
        folder={search.folder}
        onFolderChange={(folder) => setSearch({ folder }, { replace: true })}
      />
    );
  } else if (step === 'mappings') {
    footer = {
      onBack: () => go('source'),
      hint: 'Unmapped values use the fallback and show a warning.',
      next: { label: 'Preview', kbd: submitHint, onPress: () => go('preview'), isDisabled: !mappings },
    };
    body = detection.error ? (
      <Banner>{errorMessage(detection.error)}</Banner>
    ) : mappings ? (
      <MappingsEditor
        view={mappings}
        onChange={onMappingsChange}
        members={members.data?.items ?? []}
        onCreateAgent={setAgentDraft}
        onInvite={setInviteDraft}
        invited={invited}
      />
    ) : (
      <Skeleton height={240} />
    );
  } else if (step === 'preview') {
    const total = preview.data ? previewTotal(preview.data) : null;
    footer = {
      onBack: () => go('mappings'),
      hint: 'Takes about a minute for 1,000 files.',
      next: {
        label:
          mode === 'import'
            ? total === null
              ? 'Import'
              : `Import ${n(total)} ${total === 1 ? 'task' : 'tasks'}`
            : 'Start mirroring',
        kbd: submitHint,
        onPress: () => start.mutate(),
        isDisabled: !preview.data || preview.isPlaceholderData,
        isPending: start.isPending,
      },
    };
    body = (
      <>
        {start.isError ? <Banner>{errorMessage(start.error)}</Banner> : null}
        {preview.isError ? (
          <Banner
            action={
              <Button variant="secondary" size="sm" onPress={() => void preview.refetch()}>
                Retry
              </Button>
            }
          >
            {errorMessage(preview.error)}
          </Banner>
        ) : preview.data ? (
          <PreviewStep
            mode={mode}
            projectKey={projectKey}
            projectName={project.name}
            preview={preview.data}
          />
        ) : (
          <Skeleton height={240} />
        )}
      </>
    );
  } else if (source) {
    const reading = phase === 'reading';
    footer = {
      hint: reading ? 'Running in the background.' : undefined,
      next: { label: `Open ${project.name}`, kbd: submitHint, onPress: openProject, isDisabled: reading },
    };
    body = (
      <ReadStep
        status={source}
        projectName={project.name}
        settingsHref={settingsHref}
        webhookHref={backlogWebhookHref(workspace, projectKey)}
        expected={{
          tasks: preview.data ? previewTotal(preview.data) : null,
          milestones: preview.data
            ? preview.data.counts.milestones + preview.data.counts.archivedMilestones
            : null,
        }}
      />
    );
  } else {
    footer = {};
    body = null;
  }

  useContinueShortcut(
    () => {
      const next = footer.next;
      if (next && !next.isDisabled && !next.isPending) next.onPress();
    },
    !newFromOpen && !agentDraft && !inviteDraft,
  );
  useHotkeys({ Escape: { handler: cancel, enabled: !newFromOpen && !agentDraft && !inviteDraft } });

  const verb = (source?.mode ?? mode) === 'import' ? 'Import' : 'Mirror';
  return (
    <>
      <SetupFrame
        title={`${verb} Backlog.md into ${project.name}`}
        projectKey={projectKey}
        subtitle={beforeStart ? <>{project.name} · nothing is written until you start</> : project.name}
        onCancel={cancel}
        steps={steps}
        navHint={navHint}
        footer={footer}
      >
        {body}
      </SetupFrame>
      <NewFromBacklogDialogHost isOpen={newFromOpen} onClose={() => setNewFromOpen(false)} />
      <CreateAgentHost
        draft={agentDraft}
        projectId={project.id}
        onClose={() => setAgentDraft(null)}
        onCreated={(draft, agent) => {
          if (mappings) onMappingsChange(assignAgent(mappings, draft.from, agent.id));
        }}
      />
      <InviteHost
        draft={inviteDraft}
        onClose={() => setInviteDraft(null)}
        onCreated={(draft, invitation) => setInvited((all) => ({ ...all, [draft.from]: invitation.email }))}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Edit mappings (from project settings)
// ---------------------------------------------------------------------------

function EditMappings({ project }: { project: ProjectWithCounts }) {
  const workspace = useWorkspaceSlug();
  const api = useApi();
  const projectKey = project.key;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setSearch = useSetSearch(projectKey);
  const submitHint = useSubmitHint();
  const settingsHref = projectSettingsHref(workspace, projectKey);
  const status = useQuery(sourceStatusQuery(api, projectKey));
  const members = useQuery(membersQuery(api));
  const [edited, setEdited] = useState<BacklogMappingsView | null>(null);
  const [agentDraft, setAgentDraft] = useState<AgentSuggestion | null>(null);
  const [inviteDraft, setInviteDraft] = useState<InviteDraft | null>(null);
  // Invitations made here (value to email). Screen state only: nothing maps on accept.
  const [invited, setInvited] = useState<Record<string, string>>({});
  const view = edited ?? status.data?.mappings ?? null;
  const noSource = status.error instanceof SettingsError && status.error.code === 'NOT_FOUND';
  const detached = status.data?.state === 'detached';

  const save = useMutation({
    mutationFn: (next: BacklogMappingsView) =>
      unwrap(
        updateBacklogMappingsFn({
          data: { workspace: api.slug, input: { projectKey, mappings: toMappings(next) } },
        }),
      ),
    onSuccess: (source) => {
      queryClient.setQueryData(sourceStatusQuery(api, projectKey).queryKey, source);
      void queryClient.invalidateQueries({ queryKey: setupQueryKey(api) });
      void navigate({ href: settingsHref });
    },
  });

  const cancel = () => void navigate({ href: settingsHref });
  const canSave = Boolean(view && edited && !detached);
  const onSave = () => {
    if (view && canSave && !save.isPending) save.mutate(view);
  };
  useContinueShortcut(onSave, !agentDraft && !inviteDraft);
  useHotkeys({ Escape: { handler: cancel, enabled: !agentDraft && !inviteDraft } });

  let body: ReactNode;
  if (status.isPending) body = <Skeleton height={240} />;
  else if (noSource) {
    body = (
      <DetailBox tone="error">
        <div className="flex flex-col gap-2">
          <span>
            <b className="font-semibold">{project.name} doesn't read Backlog.md.</b> Set up a mirror or an
            import first; the mappings come with it.
          </span>
          <span>
            <Button size="sm" onPress={() => setSearch({ edit: undefined, step: undefined, mode: 'mirror' })}>
              Set up a mirror
            </Button>
          </span>
        </div>
      </DetailBox>
    );
  } else if (status.isError) body = <Banner>{errorMessage(status.error)}</Banner>;
  else if (detached) {
    body = (
      <DetailBox tone="ok">
        <b className="font-semibold">{project.name} is detached from Backlog.md.</b> Its tasks are edited here
        now, so there is nothing to map. The history is in{' '}
        <TextLink href={settingsHref}>Settings → Backlog.md</TextLink>.
      </DetailBox>
    );
  } else if (view) {
    body = (
      <>
        {save.isError ? <Banner>{errorMessage(save.error)}</Banner> : null}
        <MappingsEditor
          view={view}
          onChange={setEdited}
          members={members.data?.items ?? []}
          isDisabled={save.isPending}
          title="Match Backlog.md values to this app"
          aside="The next refresh applies them to every task."
          onCreateAgent={setAgentDraft}
          onInvite={setInviteDraft}
          invited={invited}
        />
      </>
    );
  }

  return (
    <>
      <SetupFrame
        title={`Edit Backlog.md mappings for ${project.name}`}
        projectKey={projectKey}
        subtitle={<>{project.name} · nothing changes until you save</>}
        onCancel={cancel}
        steps={null}
        navHint="Mappings turn the values in the files into statuses, priorities and assignees here. Saving reapplies them to every task on the next refresh."
        footer={{
          hint: 'Unmapped values use the fallback and show a warning.',
          next:
            noSource || detached
              ? null
              : {
                  label: 'Save mappings',
                  kbd: submitHint,
                  onPress: onSave,
                  isDisabled: !canSave,
                  isPending: save.isPending,
                },
        }}
      >
        {body}
      </SetupFrame>
      <CreateAgentHost
        draft={agentDraft}
        projectId={project.id}
        onClose={() => setAgentDraft(null)}
        onCreated={(draft, agent) => {
          if (view) setEdited(assignAgent(view, draft.from, agent.id));
        }}
      />
      <InviteHost
        draft={inviteDraft}
        onClose={() => setInviteDraft(null)}
        onCreated={(draft, invitation) => setInvited((all) => ({ ...all, [draft.from]: invitation.email }))}
      />
    </>
  );
}
