import { useQueries, useQuery } from '@tanstack/react-query';
import type { HomeItem } from '@zamu/contracts';
import { useMemo, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { labelsQuery } from '~/features/labels/queries';
import { projectsQuery } from '~/features/tasks/queries';
import {
  buildFilterFields,
  chipText,
  FieldFilterPopover,
  type FilterField,
  type FilterFieldConfig,
  type FilterLabel,
  FilterMenu,
  fieldValues,
  type TaskFilter,
} from '~/features/views';
import { useViewRequests } from '~/features/views/requests';
import { useApi } from '~/lib/workspace';
import { Button, CloseGlyph, cn, type PickerMenuItem, PlusGlyph, ProjectTile } from '~/ui';
import type { HomeFilter } from './search';

// Home's filter (brief "Filter in list, board and Home"): Project, Labels (names merged across
// projects) and Priority, in the views Filter menu and chips. The views filter model has no project
// field, so Home adds one with the same menu and chip components: the menu reads and writes a field by
// its name, and the project keys ride along in the filter object.

/** The project field. Not one of FILTER_FIELDS: Home keeps it in its own `project` param. */
const PROJECT_FIELD = 'project' as FilterField;

/** Home's fields, in menu and chip order. */
const HOME_FIELDS = [PROJECT_FIELD, 'label', 'priority'] as const;

/**
 * The filter menu's fields. Label lists load per project, so they wait until the filter is used
 * (`wanted`) or a label filter is set; until then the labels on the rows fill the menu.
 */
export function useHomeFilterFields(
  filter: HomeFilter,
  items: readonly HomeItem[],
  wanted: boolean,
): FilterFieldConfig[] {
  const api = useApi();
  const projects = useQuery(projectsQuery(api)).data?.items;
  const loadLabels = wanted || Boolean(filter.label?.length);
  const labelLists = useQueries({
    queries: (projects ?? []).map((project) => ({ ...labelsQuery(api, project.key), enabled: loadLabels })),
    combine: labelItems,
  });
  const labels = useMemo(
    () =>
      mergeLabels([...labelLists.flat(), ...items.flatMap((item) => item.task.labels ?? [])], filter.label),
    [labelLists, items, filter.label],
  );
  return useMemo(() => {
    const projectOptions: PickerMenuItem[] = (projects ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map((project) => ({
        id: project.key,
        label: project.name,
        lead: <ProjectTile projectKey={project.key} name={project.name} size={14} />,
        meta: project.key,
      }));
    const project: FilterFieldConfig = {
      field: PROJECT_FIELD,
      label: 'Project',
      plural: 'projects',
      multiple: true,
      placeholder: 'Project…',
      options: projectOptions,
    };
    return [project, ...buildFilterFields({ fields: ['label', 'priority'], labels })];
  }, [projects, labels]);
}

type LabelListResult = { data?: { items: readonly FilterLabel[] } | undefined };

/** Stable across renders while no list changes (TanStack keeps a stable combine's result). */
function labelItems(results: readonly LabelListResult[]): FilterLabel[][] {
  return results.map((result) => [...(result.data?.items ?? [])]);
}

/**
 * One entry per label name (ignoring case): the first colour seen, usage summed. Names set in the
 * filter but not loaded yet still get an entry, so their chip reads the name.
 */
export function mergeLabels(
  labels: readonly { name: string; color: number; usageCount?: number }[],
  selected: readonly string[] = [],
): FilterLabel[] {
  const byName = new Map<string, FilterLabel>();
  for (const label of labels) {
    const id = label.name.toLowerCase();
    const known = byName.get(id);
    if (!known) {
      byName.set(id, { id: label.name, name: label.name, color: label.color, usageCount: label.usageCount });
    } else if (label.usageCount !== undefined) {
      known.usageCount = (known.usageCount ?? 0) + label.usageCount;
    }
  }
  for (const name of selected) {
    if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { id: name, name, color: 9 });
  }
  // The filter holds names as typed in the URL; the option ids must match them to show as checked.
  const out: FilterLabel[] = [];
  for (const label of byName.values()) {
    const picked = selected.find((name) => name.toLowerCase() === label.name.toLowerCase());
    out.push(picked ? { ...label, id: picked } : label);
  }
  // Rows carry no usage counts: leave them out when no list has loaded, rather than show zeros.
  return out.map(({ usageCount, ...label }) => (usageCount ? { ...label, usageCount } : label));
}

/** True once the person reaches for the filter: the label lists start loading. */
export function useFilterWanted(): [boolean, () => void] {
  const [wanted, setWanted] = useState(false);
  useViewRequests((request) => {
    if (request.kind === 'filter') setWanted(true);
  });
  return [wanted, () => setWanted(true)];
}

function activeHomeFields(filter: HomeFilter): FilterField[] {
  return HOME_FIELDS.filter((field) => fieldValues(filter as TaskFilter, field).length > 0);
}

function without(filter: HomeFilter, field: FilterField): HomeFilter {
  const { [field as keyof HomeFilter]: _removed, ...rest } = filter;
  return rest;
}

export interface HomeFilterChipsProps {
  fields: readonly FilterFieldConfig[];
  filter: HomeFilter;
  onChange: (filter: HomeFilter) => void;
}

/**
 * The chips row under the header while a filter is set (frame 013): a chip per field (its value opens
 * the field's values, × removes it), + Filter and Clear. Renders nothing without a filter.
 */
export function HomeFilterChips({ fields, filter, onChange }: HomeFilterChipsProps) {
  const active = activeHomeFields(filter);
  const [adding, setAdding] = useState(false);
  if (active.length === 0) return null;
  const asTask = filter as TaskFilter;
  const change = (next: TaskFilter) => onChange(next as HomeFilter);
  return (
    <div
      role="toolbar"
      aria-label="Filters"
      className="flex h-10.5 shrink-0 items-center gap-1.5 border-b border-line-soft pr-3.5 pl-4.5"
    >
      {active.map((field) => {
        const config = fields.find((item) => item.field === field);
        if (!config) return null;
        const words = chipText(config, fieldValues(asTask, field));
        return (
          <span
            key={field}
            data-filter-chip={field}
            className="inline-flex h-6.5 shrink-0 items-center overflow-hidden rounded-pill bg-bg-lane text-sm"
          >
            <FieldFilterPopover config={config} filter={asTask} onChange={change}>
              <AriaButton
                aria-label={`${config.label} ${words.op} ${words.value}. Change`}
                className="inline-flex h-full cursor-pointer items-center gap-1 pr-1 pl-2.25 outline-none hover:bg-line-soft focus-visible:shadow-[var(--focus-ring)]"
              >
                <span className="text-fg-3">{config.label}</span>
                <span className="px-1 text-fg-3">{words.op}</span>
                <span className="font-medium text-fg">{words.value}</span>
              </AriaButton>
            </FieldFilterPopover>
            <AriaButton
              aria-label={`Remove the ${config.label.toLowerCase()} filter`}
              onPress={() => onChange(without(filter, field))}
              className="inline-flex h-full cursor-pointer items-center border-l border-line pr-2.25 pl-1.5 text-fg-3 outline-none hover:bg-line-soft hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
            >
              <CloseGlyph />
            </AriaButton>
          </span>
        );
      })}
      <FilterMenu fields={fields} filter={asTask} onChange={change} isOpen={adding} onOpenChange={setAdding}>
        <Button variant="quiet" size="sm" aria-label="Add a filter">
          <PlusGlyph />
          Filter
        </Button>
      </FilterMenu>
      <span className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        className={cn('text-sm text-accent-text')}
        onPress={() => onChange({})}
      >
        Clear
      </Button>
    </div>
  );
}
