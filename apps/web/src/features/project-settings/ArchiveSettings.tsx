// Project settings, Archive (M7 frames 081, 082): "Archive finished tasks" and the number of days (1 to
// 365, 14 when turned on), with the count the next nightly run would archive shown before saving. Off,
// the page says how many finished tasks the project has. Owners and admins change it; everyone else reads.
// A project that mirrors Backlog.md has no setting: its archive/tasks/ folder decides.

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Input, Label, TextField } from 'react-aria-components';
import { isMirrored, useProjectSummary } from '~/features/project-header';
import { meQuery } from '~/features/projects/queries';
import { isAdminRole } from '~/features/settings/format';
import { useApi } from '~/lib/workspace';
import {
  ArchiveGlyph,
  Banner,
  Button,
  cn,
  FieldError,
  InlineCode,
  inputBase,
  ReadOnlyNote,
  Skeleton,
  Switch,
} from '~/ui';
import {
  archiveFailure,
  DAYS_ERROR,
  DEFAULT_ARCHIVE_AFTER_DAYS,
  offText,
  parseDays,
  previewText,
} from './archive';
import { SettingsPage } from './ProjectSettingsLayout';
import { archivePreviewQuery, finishedCountsQuery } from './queries';

export const ARCHIVE_DESCRIPTION =
  'Finished tasks leave lists, boards and counts after a while. They stay searchable and can be restored.';

/** The Archive page wired to the API. */
export function ArchiveSettings({ projectKey }: { projectKey: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const project = useProjectSummary(projectKey);
  const me = useQuery(meQuery(api));

  if (!project) {
    return (
      <SettingsPage title="Archive" description={ARCHIVE_DESCRIPTION}>
        <div aria-busy className="flex flex-col gap-3">
          <Skeleton height={18} width={260} />
          <Skeleton width={420} />
        </div>
      </SettingsPage>
    );
  }

  if (isMirrored(project)) {
    return (
      <SettingsPage title="Archive" description={ARCHIVE_DESCRIPTION}>
        <ReadOnlyNote>
          {project.name} mirrors Backlog.md, so archiving follows its <InlineCode>archive/tasks/</InlineCode>{' '}
          folder: a task whose file moves there is archived here, and moving the file back restores it.
        </ReadOnlyNote>
      </SettingsPage>
    );
  }

  return (
    <ArchiveForm
      // Another project starts the form over; a save keeps it, with "Saved." showing.
      key={project.key}
      projectKey={project.key}
      projectName={project.name}
      value={project.archiveAfterDays ?? null}
      canEdit={isAdminRole(me.data?.role)}
      onSave={async (archiveAfterDays) => {
        await api.client.projects.update({ project: project.key, archiveAfterDays });
        await queryClient.invalidateQueries({ queryKey: api.orpc.projects.key() });
      }}
    />
  );
}

export interface ArchiveFormProps {
  projectKey: string;
  projectName: string;
  /** The saved setting: days, or null when off. */
  value: number | null;
  /** Owners and admins. */
  canEdit: boolean;
  /** Saves days (null turns it off); rejects with the API error. */
  onSave: (archiveAfterDays: number | null) => Promise<void>;
}

export function ArchiveForm({ projectKey, projectName, value, canEdit, onSave }: ArchiveFormProps) {
  const api = useApi();
  const descriptionId = useId();
  const [on, setOn] = useState(value !== null);
  const [daysText, setDaysText] = useState(String(value ?? DEFAULT_ARCHIVE_AFTER_DAYS));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [touched, setTouched] = useState(false);

  const days = parseDays(daysText);
  const previewDays = useDebounced(on ? days : null, 250);
  const preview = useQuery({
    ...archivePreviewQuery(api, projectKey, previewDays ?? DEFAULT_ARCHIVE_AFTER_DAYS),
    enabled: previewDays !== null,
    placeholderData: keepPreviousData,
  });
  const finished = useQuery({ ...finishedCountsQuery(api, projectKey), enabled: !on }).data;

  const next = on ? days : null;
  const dirty = on !== (value !== null) || (on && days !== value);
  const daysError = on && (touched || !dirty) && days === null ? DAYS_ERROR : undefined;

  const edit = () => {
    setFailure(null);
    setSaved(false);
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canEdit || pending || !dirty) return;
    if (on && next === null) {
      setTouched(true);
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      await onSave(next);
      setSaved(true);
    } catch (error) {
      setFailure(archiveFailure(error));
    } finally {
      setPending(false);
    }
  };

  const cancel = () => {
    setOn(value !== null);
    setDaysText(String(value ?? DEFAULT_ARCHIVE_AFTER_DAYS));
    setTouched(false);
    edit();
  };

  return (
    <SettingsPage title="Archive" description={ARCHIVE_DESCRIPTION}>
      <form
        noValidate
        onSubmit={submit}
        aria-label="Archive"
        className="flex flex-col gap-4 border-t border-line-soft pt-5"
      >
        {failure ? <Banner>{failure}</Banner> : null}
        <div className="flex flex-col gap-1">
          <Switch
            isSelected={on}
            isDisabled={!canEdit || pending}
            aria-describedby={descriptionId}
            onChange={(selected) => {
              setOn(selected);
              // Turning it on starts from the saved days, or 14.
              if (selected && parseDays(daysText) === null) setDaysText(String(DEFAULT_ARCHIVE_AFTER_DAYS));
              edit();
            }}
            className="items-start gap-3.5 text-md font-semibold text-fg"
          >
            Archive finished tasks
          </Switch>
          <p id={descriptionId} className="m-0 pl-11 text-sm leading-prose text-pretty text-fg-2">
            Done and Canceled tasks are archived a set number of days after they reached that status.
          </p>
        </div>
        {on ? (
          <>
            <TextField
              value={daysText}
              onChange={(text) => {
                setDaysText(text.replace(/[^\d]/g, '').slice(0, 3));
                edit();
              }}
              onBlur={() => setTouched(true)}
              isReadOnly={!canEdit}
              isInvalid={Boolean(daysError)}
              validationBehavior="aria"
              className="flex flex-col gap-1.5"
            >
              <span className="flex items-center gap-2">
                <Label className="text-sm text-fg-2">Archive after</Label>
                <Input
                  inputMode="numeric"
                  autoComplete="off"
                  aria-describedby={`${descriptionId}-days`}
                  className={cn(inputBase, 'h-9 w-16 text-center tabular-nums')}
                />
                <span id={`${descriptionId}-days`} className="text-sm text-fg-2">
                  days
                </span>
              </span>
              <FieldError>{daysError}</FieldError>
            </TextField>
            {days !== null ? (
              <PreviewLine
                days={previewDays}
                count={preview.data?.count}
                stale={previewDays !== days || preview.isPlaceholderData}
                failed={preview.isError}
              />
            ) : null}
          </>
        ) : (
          <p className="m-0 text-xs text-fg-2">{offText(projectName, finished)}</p>
        )}
        {canEdit && dirty ? (
          <div className="flex items-center gap-2">
            <Button type="submit" isPending={pending}>
              Save
            </Button>
            <Button variant="secondary" onPress={cancel} isDisabled={pending}>
              Cancel
            </Button>
          </div>
        ) : null}
        {saved && !dirty ? (
          <span role="status" className="text-sm text-fg-2">
            Saved.
          </span>
        ) : null}
        {!canEdit ? (
          <p className="m-0 text-xs text-fg-3">Only owners and admins change the archive setting.</p>
        ) : null}
      </form>
    </SettingsPage>
  );
}

/** "60 tasks were finished more than 14 days ago and will be archived tonight" (frame 082). */
function PreviewLine({
  days,
  count,
  stale,
  failed,
}: {
  days: number | null;
  count: number | undefined;
  stale: boolean;
  failed: boolean;
}) {
  const box = 'flex items-center gap-2 rounded-md bg-bg-lane px-3 py-2.5 text-sm text-fg-2';
  if (days === null || (count === undefined && !failed)) {
    return (
      <div aria-busy className={box}>
        <ArchiveGlyph />
        <Skeleton width="45%" />
      </div>
    );
  }
  if (count === undefined) {
    return (
      <div className={box}>
        <ArchiveGlyph />
        <span>Couldn’t count the tasks this would archive. The setting still saves.</span>
      </div>
    );
  }
  const text = previewText(count, days);
  return (
    <div role="status" aria-busy={stale || undefined} className={cn(box, stale && 'opacity-70')}>
      <ArchiveGlyph className="text-fg-2" />
      <span className="min-w-0 flex-1">
        {'text' in text ? (
          text.text
        ) : (
          <>
            <b className="font-semibold text-fg">{text.count}</b> {text.rest}
          </>
        )}
      </span>
    </div>
  );
}

/** The value after it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
