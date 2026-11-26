import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import type { AssigneeRef, Label, Priority, TaskListItem, TaskStatus } from '@zamu/contracts';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  Button as AriaButton,
  Input as AriaInput,
  TextArea as AriaTextArea,
  TextField as AriaTextField,
  MenuTrigger,
} from 'react-aria-components';
import { labelsQuery, useCreateLabel } from '~/features/labels/queries';
import { isMirrored } from '~/features/project-header/mirror';
import { useQuickCreate } from '~/features/shell/quick-create';
import {
  AssigneeMenu,
  CycleMenu,
  CycleStateGlyph,
  cycleLabel,
  DueMenu,
  FieldPopover,
  LabelMenu,
  MilestoneMenu,
  ParentMenu,
  PriorityMenu,
  StatusMenu,
  toCycleRef,
  toMilestoneRef,
  useProjectPlanning,
  useTaskSearch,
} from '~/features/task-fields';
import { useApi, useWorkspaceSlug } from '~/lib/workspace';
import {
  Avatar,
  Banner,
  Button,
  cn,
  Dialog,
  DialogFooter,
  formatShortDate,
  Kbd,
  LabelDot,
  localToday,
  Menu,
  MenuItem,
  Modal,
  PRIORITY_LABELS,
  PriorityGlyph,
  ProjectTile,
  StatusGlyph,
  Switch,
  UnassignedAvatar,
  useHotkeys,
} from '~/ui';
import { describeError } from './errors';
import { membersQuery, meQuery, projectsQuery, useCreateTask } from './queries';
import { planningDefaultsFrom, resolveCycleDefault, resolveMilestoneDefault } from './quick-create-defaults';

// Quick create (frame 097). The shell renders it once and opens it with C (useQuickCreate().open). The
// project crumb switches projects; the serif title is focused; the property buttons set and unset
// status, priority, assignee, labels, due date, milestone, cycle and parent ("···" shows the last two
// when they are empty). Milestone and cycle start from the page the dialog opened on. ⌘↵ creates; I
// assigns to me; ⇧M and ⇧C open the milestone and cycle menus. With Create more on, the dialog stays
// for the next task. Every new task is selected in its project's list. A new subtask takes its
// parent's assignee when none is set (the server does it).

const DEFAULT_STATUS: TaskStatus = 'todo';
const DEFAULT_PRIORITY: Priority = 'none';

type MenuName = 'status' | 'priority' | 'assignee' | 'labels' | 'due' | 'milestone' | 'cycle' | 'parent';

export function QuickCreateDialog() {
  const { isOpen, close } = useQuickCreate();
  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      width={620}
      top={120}
    >
      {isOpen ? <QuickCreateForm onClose={close} /> : null}
    </Modal>
  );
}

/** A property button (margin.css .propbtn): outlined while unset, filled once set. */
function PropButton({
  label,
  isSet,
  children,
  className,
}: {
  label: string;
  isSet: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <AriaButton
      aria-label={label}
      data-set={isSet || undefined}
      className={cn(
        'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-pill border px-2.5 text-sm font-medium whitespace-nowrap outline-none focus-visible:shadow-[var(--focus-ring)]',
        isSet
          ? 'border-transparent bg-bg-lane text-fg hover:bg-bg-grp'
          : 'border-line text-fg-2 hover:bg-bg-lane hover:text-fg',
        className,
      )}
    >
      {children}
    </AriaButton>
  );
}

function QuickCreateForm({ onClose }: { onClose: () => void }) {
  const workspace = useWorkspaceSlug();
  const api = useApi();
  const {
    projectKey: requestedProject,
    status: requestedStatus,
    pickProject,
    title: requestedTitle,
  } = useQuickCreate();
  const navigate = useNavigate();
  // Read once: the page the dialog opened on decides the milestone and cycle defaults.
  const location = useRouterState({ select: (state) => state.location });
  const [pageDefaults] = useState(() =>
    planningDefaultsFrom(location.pathname, (location.search ?? {}) as Record<string, unknown>),
  );
  const projects = useQuery(projectsQuery(api)).data?.items;
  const members = useQuery(membersQuery(api)).data?.items;
  const me = useQuery(meQuery(api)).data;
  const create = useCreateTask();
  const createLabel = useCreateLabel();

  // Projects come most recently active first, so the first native one is the best guess without a
  // current project, unless the opener asked for a choice (pickProject).
  const nativeProjects = (projects ?? []).filter((item) => !isMirrored(item));
  const [project, setProject] = useState<string | undefined>(requestedProject);
  const projectKey = project ?? (pickProject ? undefined : nativeProjects[0]?.key);
  const currentProject = projects?.find((item) => item.key === projectKey);
  const [title, setTitle] = useState(requestedTitle);
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskStatus>(requestedStatus ?? DEFAULT_STATUS);
  const [priority, setPriority] = useState<Priority>(DEFAULT_PRIORITY);
  const [assignee, setAssignee] = useState<AssigneeRef | null>(null);
  const [labels, setLabels] = useState<Label[]>([]);
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [parent, setParent] = useState<Pick<TaskListItem, 'key' | 'title'> | null>(null);
  const [createMore, setCreateMore] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<MenuName | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const projectButton = useRef<HTMLButtonElement>(null);

  // Milestone and cycle: undefined follows the page default, null is "none", a string is the picked id.
  const planning = useProjectPlanning(projectKey);
  const projectLabels = useQuery({ ...labelsQuery(api, projectKey ?? ''), enabled: projectKey != null }).data
    ?.items;
  const [milestoneId, setMilestoneId] = useState<string | null | undefined>(undefined);
  const [cycleId, setCycleId] = useState<string | null | undefined>(undefined);
  const onPageProject = projectKey != null && projectKey === pageDefaults.projectKey;
  const milestone =
    milestoneId === undefined
      ? onPageProject
        ? resolveMilestoneDefault(planning.milestones, pageDefaults.milestoneId)
        : undefined
      : planning.milestones?.find((item) => item.id === milestoneId);
  const cycle =
    cycleId === undefined
      ? onPageProject
        ? resolveCycleDefault(planning.cycles, pageDefaults.cycle)
        : undefined
      : planning.cycles?.find((item) => item.id === cycleId);
  const chosenMilestone = planning.usesMilestones ? milestone : undefined;
  const chosenCycle = planning.usesCycles ? cycle : undefined;

  useEffect(() => {
    // The Modal's focus scope runs after mount; focus the title (or the project button when the opener
    // left the project to choose) once it settles.
    const frame = requestAnimationFrame(() => {
      if (pickProject) projectButton.current?.focus();
      else titleRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [pickProject]);

  const assignToMe = () => {
    if (me) setAssignee({ id: me.user.id, name: me.user.name, kind: me.user.kind, responsible: null });
  };

  const switchProject = (key: string) => {
    if (key === projectKey) return;
    if (projectKey === undefined) setTimeout(() => titleRef.current?.focus(), 0);
    setProject(key);
    // Labels, milestones, cycles and parents belong to one project: start over in the new one.
    setLabels([]);
    setParent(null);
    setMilestoneId(undefined);
    setCycleId(undefined);
  };

  const submit = async () => {
    if (create.isPending || !projectKey) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError('Give the task a title.');
      titleRef.current?.focus();
      return;
    }
    const task = await create
      .mutateAsync({
        project: projectKey,
        title: trimmed,
        ...(description.trim() ? { description } : {}),
        status,
        priority,
        // A subtask without an assignee takes its parent's (the server decides).
        ...(assignee ? { assignee: assignee.id } : parent ? {} : { assignee: null }),
        ...(chosenMilestone ? { milestone: chosenMilestone.id } : {}),
        ...(chosenCycle ? { cycle: chosenCycle.number } : {}),
        ...(labels.length ? { labels: labels.map((label) => label.name) } : {}),
        ...(dueDate ? { dueDate } : {}),
        ...(parent ? { parent: parent.key } : {}),
      })
      .catch(() => null);
    if (!task) return;
    // Show the new task focused in its list (or board, when that's the project's remembered view).
    void navigate({
      to: '/w/$workspace/p/$projectKey',
      params: { workspace, projectKey: task.project.key },
      search: { focus: task.key } as never,
    });
    if (createMore) {
      setCreated(task.key);
      setTitle('');
      setDescription('');
      create.reset();
      titleRef.current?.focus();
    } else {
      onClose();
    }
  };

  useHotkeys(
    {
      'Mod+Enter': () => void submit(),
      i: assignToMe,
      'Shift+M': planning.usesMilestones ? () => setOpenMenu('milestone') : null,
      'Shift+C': planning.usesCycles
        ? () => {
            setShowMore(true);
            setOpenMenu('cycle');
          }
        : null,
    },
    { allowInOverlays: true },
  );

  const menu = (name: MenuName) => ({
    isOpen: openMenu === name,
    onOpenChange: (open: boolean) =>
      setOpenMenu((current) => (open ? name : current === name ? null : current)),
  });
  const error = create.isError ? describeError(create.error) : null;
  const today = localToday();
  const showParent = showMore || parent != null;
  const showCycle = planning.usesCycles && (showMore || chosenCycle != null || !planning.usesMilestones);

  return (
    <Dialog aria-label="New task">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3.5 text-sm font-medium text-fg-2">
        <MenuTrigger>
          <AriaButton
            ref={projectButton}
            aria-label={`Project: ${currentProject?.name ?? 'none'}`}
            className="-mx-1 flex h-6 cursor-pointer items-center gap-2 rounded-sm px-1 outline-none hover:bg-bg-lane focus-visible:shadow-[var(--focus-ring)]"
          >
            {currentProject ? (
              <>
                <ProjectTile projectKey={currentProject.key} name={currentProject.name} />
                <span className="text-fg-2">{currentProject.name}</span>
              </>
            ) : (
              <span className="text-fg-3">Choose a project</span>
            )}
          </AriaButton>
          <Menu aria-label="Project" placement="bottom start" onAction={(key) => switchProject(String(key))}>
            {nativeProjects.map((item) => (
              <MenuItem
                key={item.key}
                id={item.key}
                lead={<ProjectTile projectKey={item.key} name={item.name} size={14} />}
              >
                {item.name}
              </MenuItem>
            ))}
          </Menu>
        </MenuTrigger>
        <span aria-hidden className="mx-0.5 text-fg-3">
          ›
        </span>
        <span>New task</span>
        {created ? <span className="text-xs font-normal text-fg-3">Created {created}</span> : null}
        <Kbd className="ml-auto">Esc</Kbd>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="contents"
      >
        <div className="flex min-h-0 flex-col gap-2.5 overflow-auto px-4 pt-3 pb-3.5">
          <AriaTextField
            aria-label="Title"
            value={title}
            onChange={(value) => {
              setTitle(value);
              if (titleError) setTitleError(null);
            }}
            isInvalid={titleError != null}
            className="flex flex-col gap-1"
          >
            <AriaInput
              ref={titleRef}
              placeholder="Task title"
              className="w-full border-0 bg-transparent p-0 font-serif text-xl font-medium text-fg outline-none placeholder:text-fg-3"
            />
            {titleError ? (
              <span role="alert" className="text-xs text-danger">
                {titleError}
              </span>
            ) : null}
          </AriaTextField>
          <AriaTextField
            aria-label="Description"
            value={description}
            onChange={setDescription}
            className="flex"
          >
            <AriaTextArea
              placeholder="Add description…"
              rows={2}
              className="max-h-60 min-h-11 w-full resize-none border-0 bg-transparent p-0 text-md leading-prose text-fg outline-none [field-sizing:content] placeholder:text-fg-3"
            />
          </AriaTextField>
          <div className="flex flex-wrap gap-1.5">
            <FieldPopover
              label="Status"
              width={262}
              {...menu('status')}
              trigger={
                <PropButton label="Status" isSet={status !== DEFAULT_STATUS}>
                  <StatusGlyph status={status} withLabel />
                </PropButton>
              }
            >
              {(close) => (
                <StatusMenu
                  value={status}
                  onClose={close}
                  onChange={(next) => {
                    setStatus(next);
                    close();
                  }}
                />
              )}
            </FieldPopover>
            <FieldPopover
              label="Priority"
              width={262}
              {...menu('priority')}
              trigger={
                <PropButton label="Priority" isSet={priority !== DEFAULT_PRIORITY}>
                  <PriorityGlyph priority={priority} decorative />
                  {priority === DEFAULT_PRIORITY ? 'Priority' : PRIORITY_LABELS[priority]}
                </PropButton>
              }
            >
              {(close) => (
                <PriorityMenu
                  value={priority}
                  onClose={close}
                  onChange={(next) => {
                    setPriority(next);
                    close();
                  }}
                />
              )}
            </FieldPopover>
            <FieldPopover
              label="Assignee"
              width={292}
              {...menu('assignee')}
              trigger={
                <PropButton label="Assignee" isSet={assignee != null}>
                  {assignee ? (
                    <>
                      <Avatar name={assignee.name} kind={assignee.kind} decorative />
                      {assignee.name}
                    </>
                  ) : (
                    <>
                      <UnassignedAvatar decorative />
                      {parent ? `Assignee of ${parent.key}` : 'Assignee'}
                    </>
                  )}
                </PropButton>
              }
            >
              {(close) => (
                <AssigneeMenu
                  value={assignee}
                  members={members}
                  meId={me?.user.id}
                  onClose={close}
                  onChange={(next) => {
                    setAssignee(next);
                    close();
                  }}
                />
              )}
            </FieldPopover>
            <FieldPopover
              label="Labels"
              width={292}
              {...menu('labels')}
              trigger={
                labels.length ? (
                  <AriaButton
                    aria-label={`Labels: ${labels.map((label) => label.name).join(', ')}`}
                    className="flex cursor-pointer flex-wrap gap-1.5 rounded-pill outline-none focus-visible:shadow-[var(--focus-ring)]"
                  >
                    {labels.map((label) => (
                      <span
                        key={label.id}
                        className="inline-flex h-7 items-center gap-1.5 rounded-pill bg-bg-lane px-2.5 text-sm font-medium text-fg hover:bg-bg-grp"
                      >
                        <LabelDot color={label.color} />
                        {label.name}
                      </span>
                    ))}
                  </AriaButton>
                ) : (
                  <PropButton label="Labels" isSet={false}>
                    Labels
                  </PropButton>
                )
              }
            >
              {(close) => (
                <LabelMenu
                  labels={projectLabels}
                  counts={new Map(labels.map((label) => [label.name.toLowerCase(), 1]))}
                  total={1}
                  projectName={currentProject?.name ?? 'this project'}
                  onClose={close}
                  onToggle={(label, on) =>
                    setLabels((current) =>
                      on
                        ? [...current.filter((item) => item.id !== label.id), label]
                        : current.filter((item) => item.name.toLowerCase() !== label.name.toLowerCase()),
                    )
                  }
                  onCreate={
                    projectKey
                      ? async (name, color) => {
                          const label = await createLabel
                            .mutateAsync({ project: projectKey, name, color })
                            .catch(() => null);
                          setLabels((current) => [
                            ...current,
                            label ?? { id: `new:${name}`, name, color, source: 'app' },
                          ]);
                        }
                      : undefined
                  }
                />
              )}
            </FieldPopover>
            <FieldPopover
              label="Due date"
              width={292}
              {...menu('due')}
              trigger={
                <PropButton label="Due date" isSet={dueDate != null}>
                  {dueDate ? `Due ${formatShortDate(dueDate, today)}` : 'Due date'}
                </PropButton>
              }
            >
              {(close) => (
                <DueMenu
                  value={dueDate}
                  today={today}
                  onClose={close}
                  onChange={(next) => {
                    setDueDate(next);
                    close();
                  }}
                />
              )}
            </FieldPopover>
            {planning.usesMilestones ? (
              <FieldPopover
                label="Milestone"
                width={292}
                {...menu('milestone')}
                trigger={
                  <PropButton label="Milestone" isSet={chosenMilestone != null}>
                    {chosenMilestone ? chosenMilestone.name : 'Milestone'}
                  </PropButton>
                }
              >
                {(close) => (
                  <MilestoneMenu
                    value={chosenMilestone ? toMilestoneRef(chosenMilestone) : null}
                    milestones={planning.milestones}
                    onClose={close}
                    onChange={(picked) => {
                      setMilestoneId(picked?.id ?? null);
                      close();
                    }}
                  />
                )}
              </FieldPopover>
            ) : null}
            {showCycle ? (
              <FieldPopover
                label="Cycle"
                width={292}
                {...menu('cycle')}
                trigger={
                  <PropButton label="Cycle" isSet={chosenCycle != null}>
                    {chosenCycle ? (
                      <>
                        <CycleStateGlyph cycle={chosenCycle} />
                        {cycleLabel(chosenCycle)}
                      </>
                    ) : (
                      'Cycle'
                    )}
                  </PropButton>
                }
              >
                {(close) => (
                  <CycleMenu
                    value={chosenCycle ? toCycleRef(chosenCycle) : null}
                    cycles={planning.cycles}
                    onClose={close}
                    onChange={(picked) => {
                      setCycleId(picked?.id ?? null);
                      close();
                    }}
                  />
                )}
              </FieldPopover>
            ) : null}
            {showParent && projectKey ? (
              <FieldPopover
                label="Parent"
                width={340}
                {...menu('parent')}
                trigger={
                  <PropButton label="Parent" isSet={parent != null}>
                    {parent ? (
                      <>
                        <span className="text-fg-3 tabular-nums">{parent.key}</span>
                        <span className="max-w-50 truncate">{parent.title}</span>
                      </>
                    ) : (
                      'Parent'
                    )}
                  </PropButton>
                }
              >
                {(close) => (
                  <QuickParentMenu
                    projectKey={projectKey}
                    value={parent}
                    onClose={close}
                    onChange={(next) => {
                      setParent(next);
                      close();
                    }}
                  />
                )}
              </FieldPopover>
            ) : null}
            {!showMore && (!showParent || !showCycle) ? (
              <AriaButton
                aria-label="More properties"
                onPress={() => setShowMore(true)}
                className="inline-flex h-7 cursor-pointer items-center rounded-pill border border-line px-2.5 text-sm text-fg-2 outline-none hover:bg-bg-lane focus-visible:shadow-[var(--focus-ring)]"
              >
                ···
              </AriaButton>
            ) : null}
          </div>
          {error ? (
            <Banner>
              Couldn't create the task. {error.message}
              {error.requestId ? (
                <>
                  {' '}
                  Request <code className="font-mono text-xs">{error.requestId}</code>.
                </>
              ) : null}
            </Banner>
          ) : null}
        </div>
        <DialogFooter
          start={
            <Switch
              isSelected={createMore}
              onChange={setCreateMore}
              className="shrink-0 whitespace-nowrap text-fg-3"
            >
              Create more
            </Switch>
          }
        >
          <Button variant="quiet" onPress={onClose}>
            Cancel
          </Button>
          <Button type="submit" kbd="⌘↵" isPending={create.isPending} isDisabled={!projectKey}>
            Create task
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** A top-level open task of the project as the new task's parent (one level of subtasks). */
function QuickParentMenu({
  projectKey,
  value,
  onChange,
  onClose,
}: {
  projectKey: string;
  value: Pick<TaskListItem, 'key' | 'title'> | null;
  onChange: (parent: Pick<TaskListItem, 'key' | 'title'> | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const results = useTaskSearch(projectKey, query, { topLevel: true }).data?.items;
  return (
    <ParentMenu
      value={value}
      results={results}
      query={query}
      onQueryChange={setQuery}
      onChange={(next) => onChange(next ? { key: next.key, title: next.title } : null)}
      onClose={onClose}
    />
  );
}
