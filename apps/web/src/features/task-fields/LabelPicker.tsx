import { useQueries } from '@tanstack/react-query';
import { LABEL_COLOR_COUNT, type Label, type LabelWithUsage, MAX_LABEL_NAME_LENGTH } from '@zamu/contracts';
import { type KeyboardEvent, useMemo, useState } from 'react';
import { labelsQuery, useCreateLabel } from '~/features/labels/queries';
import { useApi } from '~/lib/workspace';
import {
  ColorSwatches,
  LabelDot,
  MenuTip,
  PickerMenu,
  type PickerMenuItem,
  type PickerMenuSection,
} from '~/ui';
import { failureText, useFieldChange } from './apply';
import type { FieldPickerProps } from './StatusPicker';
import { FieldPopover, READ_ONLY_HINTS, ReadOnlyLine } from './shared';
import { type FieldTarget, fieldRefusal, projectKeysOf, subjectOf, toTargets } from './targets';
import { showFieldToast } from './toast';

// Labels (frames 071–073): several at once. Enter toggles and the menu stays open. The labels on the
// task come first (as they were when the menu opened), then every label of the project. Typing
// filters with a highlight; a name that matches none offers "Create label", with a colour (Tab
// reaches the swatches).

const lower = (name: string) => name.toLocaleLowerCase();

/** A label as the menu lists it: merged by name across the targets' projects (Home selections). */
export interface MenuLabel extends Label {
  usageCount: number;
}

export interface LabelMenuProps {
  /** The project's labels (or the projects', merged by name). Undefined while loading. */
  labels: readonly MenuLabel[] | undefined;
  /** How many of the targets carry each label, by lower-case name. */
  counts: ReadonlyMap<string, number>;
  /** Number of targets: a label is checked when all of them have it. */
  total: number;
  /** "Payments", for the headers. */
  projectName: string;
  /** Turn a label on (every target gets it) or off. */
  onToggle: (label: MenuLabel, on: boolean) => void;
  /** Create a label (palette hue 1–9) and put it on the targets. */
  onCreate?: (name: string, color: number) => void;
  readOnly?: boolean;
  /** Why it is read-only (defaults to the Backlog.md lock text). */
  readOnlyText?: string;
  /** A single task ("On this task") or a selection ("On these tasks"). */
  plural?: boolean;
  onClose?: () => void;
  autoFocus?: boolean;
}

export function LabelMenu({
  labels,
  counts,
  total,
  projectName,
  onToggle,
  onCreate,
  readOnly = false,
  readOnlyText,
  plural = false,
  onClose,
  autoFocus,
}: LabelMenuProps) {
  const [query, setQuery] = useState('');
  const all = labels ?? [];
  const [color, setColor] = useState<number | undefined>(undefined);
  const shownColor = color ?? leastUsedHue(all);
  const isOn = (label: MenuLabel) => total > 0 && (counts.get(lower(label.name)) ?? 0) >= total;
  const onNow = () => new Set(all.filter(isOn).map((label) => lower(label.name)));
  // The labels on the task when the menu opened stay on top while they are toggled.
  const [initiallyOn, setInitiallyOn] = useState<Set<string> | null>(() => (labels ? onNow() : null));
  if (labels && initiallyOn === null) setInitiallyOn(onNow());
  const firstOn = initiallyOn ?? new Set<string>();

  const trimmed = query.trim();
  const needle = lower(trimmed);
  const matching = trimmed ? all.filter((label) => lower(label.name).includes(needle)) : all;
  const exact = all.some((label) => lower(label.name) === needle);
  const tooLong = trimmed.length > MAX_LABEL_NAME_LENGTH;
  const canCreate = Boolean(onCreate && !readOnly && trimmed && !exact && !tooLong);
  const creating = canCreate && matching.length === 0;

  const item = (label: MenuLabel): PickerMenuItem => {
    const count = counts.get(lower(label.name)) ?? 0;
    return {
      id: lower(label.name),
      label: label.name,
      lead: <LabelDot color={label.color} />,
      meta: String(label.usageCount),
      sub: plural && count > 0 && count < total ? `on ${count} of ${total}` : undefined,
      isDisabled: readOnly,
    };
  };
  const sections: PickerMenuSection[] = trimmed
    ? [
        {
          id: 'matches',
          title: matching.length === 1 ? '1 match' : `${matching.length} matches`,
          items: matching.map(item),
        },
      ]
    : [
        {
          id: 'on',
          title: plural ? 'On these tasks' : 'On this task',
          items: all.filter((label) => firstOn.has(lower(label.name))).map(item),
        },
        {
          id: 'all',
          title: `All labels in ${projectName} · ${all.length}`,
          items: all.filter((label) => !firstOn.has(lower(label.name))).map(item),
        },
      ];
  const checked = all.filter(isOn).map((label) => lower(label.name));

  const create = () => {
    if (!canCreate) return;
    onCreate?.(trimmed, shownColor);
    setQuery('');
    setColor(undefined);
  };
  const onSwatchKey = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    create();
  };

  return (
    <PickerMenu
      aria-label="Labels"
      selectionMode="multiple"
      sections={sections}
      selectedKeys={checked}
      query={query}
      onQueryChange={setQuery}
      onAction={(id) => {
        const label = all.find((candidate) => lower(candidate.name) === id);
        if (label) onToggle(label, !isOn(label));
      }}
      create={
        canCreate
          ? {
              label: (q) => `Create label “${q}”`,
              emptyTitle: (q) => `No label named “${q}” in ${projectName}`,
              onCreate: create,
            }
          : undefined
      }
      search={{ placeholder: 'Add labels…', kbd: 'L' }}
      emptyText={
        !labels
          ? 'Loading labels…'
          : tooLong
            ? `Keep label names to ${MAX_LABEL_NAME_LENGTH} characters or fewer`
            : trimmed
              ? 'No matches'
              : 'No labels yet. Type a name to create one.'
      }
      before={readOnly ? <ReadOnlyLine>{readOnlyText}</ReadOnlyLine> : undefined}
      footer={
        readOnly
          ? { hints: READ_ONLY_HINTS }
          : creating
            ? {
                hints: [
                  { keys: '↵', label: 'create and add' },
                  { keys: 'Tab', label: 'colour' },
                ],
              }
            : {
                hints: [
                  { keys: '↵', label: 'toggle' },
                  { keys: 'Esc', label: 'done' },
                ],
                end: `${checked.length} selected`,
              }
      }
      onClose={onClose}
      autoFocus={autoFocus}
      // Frame 071 shows about fourteen labels before the list scrolls.
      maxListHeight={480}
    >
      {creating ? (
        <>
          {/* Enter on a swatch creates the label with that colour. */}
          <div className="px-2 pt-0.5 pb-1.5" onKeyDownCapture={onSwatchKey}>
            <ColorSwatches label="Colour" size={18} value={shownColor} onChange={setColor} />
          </div>
          <MenuTip>
            Labels named “{trimmed}” in other projects show as one label in workspace filters.
          </MenuTip>
        </>
      ) : null}
    </PickerMenu>
  );
}

/** The hue fewest labels use (the lowest on a tie), as the server picks for a new label. */
export function leastUsedHue(labels: readonly Pick<Label, 'color'>[]): number {
  const uses = Array.from({ length: LABEL_COLOR_COUNT }, (_, index) => ({
    hue: index + 1,
    count: labels.filter((label) => label.color === index + 1).length,
  }));
  uses.sort((a, b) => a.count - b.count || a.hue - b.hue);
  return uses[0]?.hue ?? 1;
}

/** The labels of the targets' projects, merged by name (case-insensitive), by name. */
function useMenuLabels(projectKeys: readonly string[]): MenuLabel[] | undefined {
  const api = useApi();
  const results = useQueries({ queries: projectKeys.map((key) => labelsQuery(api, key)) });
  const data = results.map((result) => result.data);
  const ready = data.every((item) => item !== undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `data` changes identity every render; the items don't.
  return useMemo(() => {
    if (!ready) return undefined;
    const merged = new Map<string, MenuLabel>();
    for (const list of data) {
      for (const label of (list?.items ?? []) as LabelWithUsage[]) {
        const known = merged.get(lower(label.name));
        if (known) known.usageCount += label.usageCount;
        else merged.set(lower(label.name), { ...label });
      }
    }
    return [...merged.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }, [ready, ...data]);
}

/** How many targets carry each label, by lower-case name. */
export function labelCounts(targets: readonly FieldTarget[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const target of targets) {
    for (const label of target.labels ?? [])
      counts.set(lower(label.name), (counts.get(lower(label.name)) ?? 0) + 1);
  }
  return counts;
}

function LabelPickerContent({ targets, close }: { targets: FieldTarget[]; close: () => void }) {
  const projectKeys = projectKeysOf(targets);
  const labels = useMenuLabels(projectKeys);
  const { apply } = useFieldChange();
  const createLabel = useCreateLabel();
  const reason = fieldRefusal(targets, 'labels');
  const single = projectKeys.length === 1 ? targets[0]?.project : undefined;
  return (
    <LabelMenu
      labels={labels}
      counts={labelCounts(targets)}
      total={targets.length}
      projectName={single?.name ?? 'these projects'}
      plural={targets.length > 1}
      readOnly={reason != null}
      readOnlyText={reason ?? undefined}
      onClose={close}
      onToggle={(label, on) => {
        void apply(targets, on ? { addLabels: [label] } : { removeLabels: [label.name] });
      }}
      onCreate={async (name, color) => {
        if (!single) {
          // Labels resolve per project by name: each project creates its own.
          void apply(targets, { addLabels: [{ id: `new:${name}`, name, color, source: 'app' }] });
          return;
        }
        try {
          const label = await createLabel.mutateAsync({ project: single.key, name, color });
          void apply(targets, { addLabels: [label] });
        } catch (error) {
          showFieldToast({ text: failureText(subjectOf(targets), error), tone: 'error' });
        }
      }}
    />
  );
}

export function LabelPicker({ targets, ...anchor }: FieldPickerProps) {
  const list = toTargets(targets);
  return (
    <FieldPopover label="Labels" width={292} {...anchor}>
      {(close) => <LabelPickerContent targets={list} close={close} />}
    </FieldPopover>
  );
}
