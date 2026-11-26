// Project settings, Labels (frames 115 to 126): the labels of a project with how many tasks use them.
// Rows show the colour dot, the name and "12 tasks"; hover or focus shows Rename (✎) and a menu (Rename,
// Change colour, Delete). Rename works in place (Enter saves, Esc cancels, a taken name shows under the
// field). The dot opens the colour popover; a pick saves at once. Delete asks first and says how many tasks
// lose the label. Labels from Backlog.md files (source "backlog") keep their name: they show a lock and
// "From Backlog.md", Rename and Delete are off, and only the colour changes (never written to the files).

import { type QueryKey, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LabelWithUsage } from '@zamu/contracts';
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger,
  Input,
  SearchField,
} from 'react-aria-components';
import { labelsQuery, useCreateLabel, useDeleteLabel, useUpdateLabel } from '~/features/labels/queries';
import { isMirrored, useProjectSummary } from '~/features/project-header';
import { usePageSearchRef } from '~/features/shell/page-search';
import { leastUsedHue } from '~/features/task-fields/LabelPicker';
import { useApi } from '~/lib/workspace';
import {
  Banner,
  Button,
  ColorSwatches,
  ConfirmDialog,
  cn,
  EmptyState,
  inputBase,
  LabelDot,
  LockGlyph,
  Menu,
  MenuItem,
  MenuSeparator,
  MenuTip,
  MenuTrigger,
  Popover,
  SearchGlyph,
  Skeleton,
  SourceBadge,
  TextField,
  Tooltip,
  TooltipTrigger,
} from '~/ui';
import { filterLabels, labelCountText, labelFailure, labelNameError, sortLabels, usageText } from './labels';
import { SettingsPage } from './ProjectSettingsLayout';

/** The Labels page wired to the API. */
export function LabelsSettings({ projectKey }: { projectKey: string }) {
  const api = useApi();
  const project = useProjectSummary(projectKey);
  const projectName = project?.name ?? projectKey;
  const query = labelsQuery(api, projectKey);
  const labels = useQuery(query);
  const queryClient = useQueryClient();
  const create = useCreateLabel();
  const update = useUpdateLabel();
  const remove = useDeleteLabel();

  /** Writes a label into the cached list at once (the colour pick), and gives back the undo. */
  const patchCached = (key: QueryKey, id: string, patch: Partial<LabelWithUsage>) => {
    const before = queryClient.getQueryData<{ items: LabelWithUsage[] }>(key);
    if (before) {
      queryClient.setQueryData(key, {
        ...before,
        items: before.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      });
    }
    return () => {
      if (before) queryClient.setQueryData(key, before);
    };
  };

  return (
    <LabelsView
      projectName={projectName}
      mirrored={isMirrored(project)}
      labels={labels.data?.items}
      loadError={labels.error ? labelFailure(labels.error, projectName, '') : null}
      onRetry={() => void labels.refetch()}
      onCreate={async (name, color) => {
        await create.mutateAsync({ project: projectKey, name, color });
      }}
      onRename={async (label, name) => {
        await update.mutateAsync({ project: projectKey, id: label.id, name });
      }}
      onRecolour={async (label, color) => {
        const undo = patchCached(query.queryKey, label.id, { color });
        try {
          await update.mutateAsync({ project: projectKey, id: label.id, color });
        } catch (error) {
          undo();
          throw error;
        }
      }}
      onDelete={async (label) => {
        await remove.mutateAsync({ project: projectKey, id: label.id });
      }}
    />
  );
}

export interface LabelsViewProps {
  projectName: string;
  /** The project reads Backlog.md: no New label, and the note about names from the files. */
  mirrored: boolean;
  /** undefined while loading. */
  labels: readonly LabelWithUsage[] | undefined;
  loadError?: string | null;
  onRetry?: () => void;
  /** Each write rejects with the API error; the view turns it into text. */
  onCreate: (name: string, color: number) => Promise<void>;
  onRename: (label: LabelWithUsage, name: string) => Promise<void>;
  onRecolour: (label: LabelWithUsage, color: number) => Promise<void>;
  onDelete: (label: LabelWithUsage) => Promise<void>;
}

/** What a row is doing: renaming in place, or showing the colour popover. */
type RowMode = { id: string; kind: 'rename' | 'recolour' } | null;

export function LabelsView({
  projectName,
  mirrored,
  labels,
  loadError,
  onRetry,
  onCreate,
  onRename,
  onRecolour,
  onDelete,
}: LabelsViewProps) {
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<RowMode>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<LabelWithUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = usePageSearchRef();

  const all = labels ?? [];
  const sorted = sortLabels(all);
  const shown = filterLabels(sorted, filter);
  const hasLocked = all.some((label) => label.source === 'backlog');
  const canCreate = !mirrored;
  const empty = labels !== undefined && all.length === 0 && !creating;

  const startCreate = () => {
    setMode(null);
    setFilter('');
    setCreating(true);
  };

  const recolour = (label: LabelWithUsage, color: number) => {
    setError(null);
    onRecolour(label, color).catch((failure: unknown) =>
      setError(
        `Couldn't change the colour of “${label.name}”. ${labelFailure(failure, projectName, label.name)}`,
      ),
    );
  };

  return (
    <SettingsPage
      title="Labels"
      description={
        mirrored
          ? `Labels used by ${projectName}’s tasks.`
          : `Labels group tasks inside ${projectName}. Labels with the same name in other projects show as one label in workspace filters.`
      }
    >
      {hasLocked || mirrored ? (
        <Banner tone="note">
          {projectName}’s labels come from its Backlog.md files. Rename or remove them in the files. Colours
          are set here and never written to the files.
        </Banner>
      ) : null}
      {error ? (
        <Banner
          action={
            <Button variant="secondary" size="sm" onPress={() => setError(null)}>
              Dismiss
            </Button>
          }
        >
          {error}
        </Banner>
      ) : null}
      {loadError ? (
        <Banner
          action={
            onRetry ? (
              <Button variant="secondary" size="sm" onPress={onRetry}>
                Try again
              </Button>
            ) : null
          }
        >
          Couldn't load the labels. {loadError}
        </Banner>
      ) : null}
      {empty ? null : (
        <div className="flex items-center gap-2">
          <SearchField
            aria-label="Filter labels"
            value={filter}
            onChange={setFilter}
            isDisabled={labels === undefined}
            className="group relative flex w-65 items-center"
          >
            <SearchGlyph className="pointer-events-none absolute left-3 text-fg-3" />
            <Input
              ref={searchRef}
              placeholder="Filter labels"
              className={cn(inputBase, 'h-8 pl-8.5 [&::-webkit-search-cancel-button]:hidden')}
            />
          </SearchField>
          <span className="flex-1" />
          {labels ? (
            <span role="status" className="text-sm text-fg-2 tabular-nums">
              {labelCountText(shown.length, all.length)}
            </span>
          ) : null}
          {canCreate ? (
            <Button onPress={startCreate} isDisabled={creating || labels === undefined}>
              New label
            </Button>
          ) : null}
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-line-soft bg-surface">
        <table
          aria-label="Labels"
          aria-busy={labels === undefined || undefined}
          className="w-full table-fixed"
        >
          <colgroup>
            <col className="w-11.5" />
            <col />
            <col className="w-33 max-[1199px]:w-27" />
            <col className="w-27 max-[1199px]:w-21" />
          </colgroup>
          <thead>
            <tr className="h-8.5 text-left text-xs font-medium text-fg-3">
              <th scope="col" className="pl-3 font-medium">
                <span className="sr-only">Colour</span>
              </th>
              <th scope="col" className="pr-3 font-medium">
                Name
              </th>
              <th scope="col" className="pr-3 font-medium">
                Used on
              </th>
              <th scope="col" className="pr-3 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {labels === undefined ? (
              <LoadingRows />
            ) : empty ? (
              <tr>
                <td colSpan={4} className={CELL}>
                  <EmptyState
                    align="center"
                    title="No labels yet"
                    text="Labels group work inside a project. Create one here, or press L on any task and type a new name."
                    action={canCreate ? <Button onPress={startCreate}>New label</Button> : null}
                    className="py-8.5"
                  />
                </td>
              </tr>
            ) : (
              <>
                {creating ? (
                  <NewLabelRow
                    labels={all}
                    projectName={projectName}
                    onCreate={async (name, color) => {
                      await onCreate(name, color);
                      setCreating(false);
                    }}
                    onCancel={() => setCreating(false)}
                  />
                ) : null}
                {shown.map((label) => (
                  <LabelRow
                    key={label.id}
                    label={label}
                    labels={all}
                    projectName={projectName}
                    mode={mode?.id === label.id ? mode.kind : null}
                    onMode={(kind) => {
                      if (kind === 'rename') setCreating(false);
                      setMode(kind ? { id: label.id, kind } : null);
                    }}
                    onRename={(name) => onRename(label, name)}
                    onRecolour={(color) => recolour(label, color)}
                    onDelete={() => setDeleting(label)}
                  />
                ))}
                {shown.length === 0 && !creating ? (
                  <tr>
                    <td colSpan={4} className={cn(CELL, 'h-11 pl-11.5 text-sm text-fg-2')}>
                      No labels match “{filter.trim()}”.
                    </td>
                  </tr>
                ) : null}
              </>
            )}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete the label “${deleting?.name ?? ''}”?`}
        confirmLabel="Delete label"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await onDelete(deleting);
          } catch (failure) {
            throw new Error(labelFailure(failure, projectName, deleting.name));
          }
        }}
      >
        {deleting ? <DeleteMessage label={deleting} projectName={projectName} /> : null}
      </ConfirmDialog>
    </SettingsPage>
  );
}

/** A body cell (screens.css .lbl-row): 44px rows with a --line-soft rule between them. */
const CELL = 'border-t border-line-soft py-1.5 align-middle';

function DeleteMessage({ label, projectName }: { label: LabelWithUsage; projectName: string }) {
  if (label.usageCount === 0) {
    return <>No task in {projectName} uses it. You can’t undo this.</>;
  }
  return (
    <>
      It’s used on <b>{usageText(label.usageCount)}</b> in {projectName}. They lose this label and keep
      everything else. You can’t undo this.
    </>
  );
}

interface LabelRowProps {
  label: LabelWithUsage;
  labels: readonly LabelWithUsage[];
  projectName: string;
  mode: 'rename' | 'recolour' | null;
  onMode: (mode: 'rename' | 'recolour' | null) => void;
  onRename: (name: string) => Promise<void>;
  onRecolour: (color: number) => void;
  onDelete: () => void;
}

function LabelRow({
  label,
  labels,
  projectName,
  mode,
  onMode,
  onRename,
  onRecolour,
  onDelete,
}: LabelRowProps) {
  const locked = label.source === 'backlog';
  const renaming = mode === 'rename' && !locked;
  const active = mode !== null;

  return (
    <tr data-active={active || undefined} className="group/row hover:bg-bg-grp data-active:bg-bg-grp">
      <td className={cn(CELL, 'h-11 pl-3')}>
        <ColourButton
          buttonLabel={`Colour of “${label.name}”`}
          title={`Colour for “${label.name}”`}
          color={label.color}
          isOpen={mode === 'recolour'}
          onOpenChange={(open) => onMode(open ? 'recolour' : null)}
          onPick={onRecolour}
        />
      </td>
      <td className={cn(CELL, 'pr-3')}>
        {renaming ? (
          <NameEditor
            initial={label.name}
            ariaLabel={`New name for “${label.name}”`}
            submitLabel="Save"
            check={(name) => labelNameError(name, labels, projectName, label.id)}
            onSubmit={async (name) => {
              if (name === label.name) return;
              await onRename(name);
            }}
            onDone={() => onMode(null)}
            projectName={projectName}
          />
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-fg">{label.name}</span>
            {locked ? <SourceBadge label="From Backlog.md" /> : null}
          </span>
        )}
      </td>
      <td className={cn(CELL, 'pr-3 text-sm text-fg-2 tabular-nums')}>{usageText(label.usageCount)}</td>
      <td className={cn(CELL, 'pr-3')}>
        <span className="flex items-center justify-end gap-0.5">
          {renaming ? null : (
            <RowActions
              label={label}
              onRename={() => onMode('rename')}
              onRecolour={() => onMode('recolour')}
              onDelete={onDelete}
            />
          )}
        </span>
      </td>
    </tr>
  );
}

function RowActions({
  label,
  onRename,
  onRecolour,
  onDelete,
}: {
  label: LabelWithUsage;
  onRename: () => void;
  onRecolour: () => void;
  onDelete: () => void;
}) {
  const locked = label.source === 'backlog';
  // Hidden until the row is hovered or holds focus; an open menu keeps them.
  const reveal =
    'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-data-active/row:opacity-100 has-[[aria-expanded=true]]:opacity-100';
  return (
    <>
      <span className={cn('flex items-center gap-0.5', reveal)}>
        {locked ? null : (
          <TooltipTrigger>
            <Button
              variant="quiet"
              size="sm"
              iconOnly
              aria-label={`Rename “${label.name}”`}
              className="text-fg-3"
              onPress={onRename}
            >
              <PencilGlyph />
            </Button>
            <Tooltip>Rename</Tooltip>
          </TooltipTrigger>
        )}
        <MenuTrigger>
          <Button
            variant="quiet"
            size="sm"
            iconOnly
            aria-label={`More actions for “${label.name}”`}
            className="text-fg-3"
          >
            <MoreGlyph />
          </Button>
          <Menu
            placement="bottom end"
            disabledKeys={locked ? ['rename', 'delete'] : []}
            onAction={(key) => {
              // Let the menu hand focus back before the next layer opens.
              if (key === 'rename') setTimeout(onRename, 0);
              if (key === 'recolour') setTimeout(onRecolour, 0);
              if (key === 'delete') onDelete();
            }}
          >
            <MenuItem id="rename">Rename</MenuItem>
            <MenuItem id="recolour">Change colour</MenuItem>
            <MenuSeparator />
            <MenuItem id="delete" tone="danger">
              Delete…
            </MenuItem>
          </Menu>
        </MenuTrigger>
      </span>
      {locked ? (
        <TooltipTrigger>
          <AriaButton
            aria-label={`“${label.name}” comes from Backlog.md. Rename or remove it in the files.`}
            className="mr-2 flex size-6.5 cursor-default items-center justify-center rounded-md text-fg-3 outline-none focus-visible:focus-ring"
          >
            <LockGlyph />
          </AriaButton>
          <Tooltip>Name from Backlog.md. Rename or remove it in the files.</Tooltip>
        </TooltipTrigger>
      ) : null}
    </>
  );
}

/** The dot that opens "Colour for “ledger”" (frame 118). */
function ColourButton({
  buttonLabel,
  title,
  color,
  isOpen,
  onOpenChange,
  onPick,
}: {
  buttonLabel: string;
  title: string;
  color: number;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (color: number) => void;
}) {
  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
      <AriaButton
        aria-label={buttonLabel}
        className={cn(
          'flex size-4 cursor-pointer items-center justify-center rounded-full outline-none',
          'focus-visible:shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--accent)]',
          isOpen && 'shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--accent)]',
        )}
      >
        <LabelDot color={color} size={16} />
      </AriaButton>
      <Popover placement="bottom start" offset={8} className="w-63 min-w-0">
        <AriaDialog aria-label={title} className="flex flex-col p-1.5 outline-none">
          <div aria-hidden className="px-2 pt-1.5 pb-1 text-xs font-medium text-fg-3">
            {title}
          </div>
          <ColorSwatches
            aria-label={title}
            size={18}
            value={color}
            onChange={onPick}
            className="px-2 pt-1.5 pb-2 [&>div]:gap-2"
          />
          <MenuTip className="mt-0">Each colour passes AA contrast in both themes.</MenuTip>
        </AriaDialog>
      </Popover>
    </DialogTrigger>
  );
}

/**
 * The name field of a row being renamed or created: Enter saves, Esc cancels, an error shows under it.
 * `onSubmit` rejects with the API error.
 */
function NameEditor({
  initial,
  ariaLabel,
  submitLabel,
  check,
  onSubmit,
  onDone,
  projectName,
  placeholder,
}: {
  initial: string;
  ariaLabel: string;
  submitLabel: string;
  check: (name: string) => string | null;
  onSubmit: (name: string) => Promise<void>;
  onDone: () => void;
  projectName: string;
  placeholder?: string;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (pending) return;
    const name = value.trim();
    const problem = check(name);
    if (problem) {
      setError(problem);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(name);
      onDone();
    } catch (failure) {
      setPending(false);
      setError(labelFailure(failure, projectName, name));
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDone();
    }
  };

  return (
    <div className="flex min-w-0 flex-1 items-start gap-1.5">
      <TextField
        aria-label={ariaLabel}
        autoFocus
        placeholder={placeholder}
        autoComplete="off"
        value={value}
        onChange={(next) => {
          setValue(next);
          setError(null);
        }}
        onFocus={(event) => (event.target as HTMLInputElement).select()}
        onKeyDown={onKeyDown}
        isInvalid={error !== null}
        errorMessage={error}
        validationBehavior="aria"
        className="min-w-0 flex-1"
        inputClassName="h-7.5"
      />
      <Button size="sm" className="mt-0.5" onPress={() => void submit()} isPending={pending}>
        {submitLabel}
      </Button>
      <Button variant="secondary" size="sm" className="mt-0.5" onPress={onDone}>
        Cancel
      </Button>
    </div>
  );
}

/** The row New label adds at the top of the table: colour, name, Create, Cancel. */
function NewLabelRow({
  labels,
  projectName,
  onCreate,
  onCancel,
}: {
  labels: readonly LabelWithUsage[];
  projectName: string;
  onCreate: (name: string, color: number) => Promise<void>;
  onCancel: () => void;
}) {
  const [color, setColor] = useState(() => leastUsedHue(labels));
  const [picking, setPicking] = useState(false);
  return (
    <tr className="bg-bg-grp">
      <td className={cn(CELL, 'h-11 pl-3')}>
        <ColourButton
          buttonLabel="Colour of the new label"
          title="Colour for the new label"
          color={color}
          isOpen={picking}
          onOpenChange={setPicking}
          onPick={setColor}
        />
      </td>
      <td className={cn(CELL, 'pr-3')}>
        <NameEditor
          initial=""
          ariaLabel="Name of the new label"
          placeholder="Label name"
          submitLabel="Create"
          check={(name) => labelNameError(name, labels, projectName)}
          onSubmit={(name) => onCreate(name, color)}
          onDone={onCancel}
          projectName={projectName}
        />
      </td>
      <td className={CELL} />
      <td className={CELL} />
    </tr>
  );
}

function LoadingRows() {
  return (
    <>
      {[120, 90, 150, 70].map((width) => (
        <tr key={width}>
          <td className={cn(CELL, 'h-11 pl-3')}>
            <Skeleton height={16} round />
          </td>
          <td className={cn(CELL, 'pr-3')}>
            <Skeleton width={width} />
          </td>
          <td className={cn(CELL, 'pr-3')}>
            <Skeleton width={56} />
          </td>
          <td className={CELL} />
        </tr>
      ))}
    </>
  );
}

function PencilGlyph(): ReactNode {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path d="M9.5 2.5 11.5 4.5 5 11H3V9z" strokeLinejoin="round" />
    </svg>
  );
}

function MoreGlyph(): ReactNode {
  return (
    <svg aria-hidden viewBox="0 0 14 14" width="14" height="14" fill="currentColor">
      <circle cx="3" cy="7" r="1.2" />
      <circle cx="7" cy="7" r="1.2" />
      <circle cx="11" cy="7" r="1.2" />
    </svg>
  );
}
