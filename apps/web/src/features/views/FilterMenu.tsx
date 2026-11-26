import { type ReactNode, type RefObject, useContext, useRef, useState } from 'react';
import {
  Button as AriaButton,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  Autocomplete,
  Input,
  MenuContext,
  MenuTrigger,
  OverlayTriggerStateContext,
  SearchField,
  SubmenuTrigger,
  useFilter,
} from 'react-aria-components';
import { Button, CloseGlyph, cn, FiltersGlyph, KeyHint, PickerMenu, PlusGlyph, Popover } from '~/ui';
import { chipText, type FilterFieldConfig, fieldValues, withFieldValues } from './filter-fields';
import {
  activeFilterFields,
  clearedFilter,
  type FilterField,
  type TaskFilter,
  withoutField,
} from './filters';
import { useViewRequests } from './requests';

// The Filter menu (frames 046, 047; components.md "Filter menu + submenu") and the chips row (013).
//
//   <FilterButton>   the header's Filter slot: button + menu (fields list → submenu per field)
//   <FilterMenu>     the same menu on any trigger ("+ Filter" in the chips row)
//   <FilterChips>    "Labels is any of 3 labels ×", + Filter, "21 of 123 tasks", Clear
//
// Changes apply as they are made (each checkbox updates the filter, so the list behind follows).
// Keys: type to narrow the fields, ↑/↓, Enter or → opens a field, type to narrow its values, Enter
// toggles, Esc goes back to the fields, Esc again closes.

const FIELDS_WIDTH = 240;
const VALUES_WIDTH = 268;

/** margin.css .menu-i, as PickerMenu draws it. */
const itemClass =
  'flex min-h-8 cursor-default items-center gap-2.25 rounded-sm px-2 whitespace-nowrap text-fg outline-none select-none focus:bg-bg-lane open:bg-bg-lane';

const searchClass = 'flex h-9 shrink-0 items-center gap-2 border-b border-line-soft px-3';
const inputClass =
  'min-w-0 flex-1 border-0 bg-transparent p-0 text-md text-fg caret-accent outline-none placeholder:text-fg-3 [&::-webkit-search-cancel-button]:hidden';

export interface FilterValuesPanelProps {
  config: FilterFieldConfig;
  filter: TaskFilter;
  onChange: (filter: TaskFilter) => void;
  /** Esc with an empty search: back to the fields list, or close (a chip's picker). */
  onBack: () => void;
  /** A one-value field was picked: close everything. */
  onDone: () => void;
  /** "back" in the fields submenu, "close" in a chip's picker. */
  escLabel?: string;
}

/** One field's values: search, checkboxes (or a check), "3 selected", ↵ apply, Esc back (frame 047). */
export function FilterValuesPanel({
  config,
  filter,
  onChange,
  onBack,
  onDone,
  escLabel = 'back',
}: FilterValuesPanelProps) {
  const selected = fieldValues(filter, config.field);
  // React Aria closes a menu on Enter even in multiple selection; here Enter toggles (shortcuts.md).
  const menuContext = useContext(MenuContext);
  return (
    <div className="flex flex-col" style={{ width: VALUES_WIDTH }}>
      <MenuContext.Provider
        value={{ ...(menuContext ?? {}), ...(config.multiple ? { shouldCloseOnSelect: false } : {}) }}
      >
        <PickerMenu
          aria-label={config.label}
          search={{ placeholder: config.placeholder, ...(config.kbd ? { kbd: config.kbd } : {}) }}
          sections={[{ id: config.field, title: config.title ?? config.label, items: config.options }]}
          selectionMode={config.multiple ? 'multiple' : 'single'}
          selectedKeys={selected}
          onSelectionChange={(ids) => onChange(withFieldValues(filter, config.field, [...ids]))}
          onAction={(id) => {
            if (config.multiple) return;
            // Picking the current value again clears the field.
            onChange(withFieldValues(filter, config.field, selected.includes(id) ? [] : [id]));
          }}
          onClose={() => (config.multiple ? onBack() : onDone())}
          emptyText="No matches"
          maxListHeight={320}
        />
      </MenuContext.Provider>
      <div className="flex shrink-0 items-center gap-3 border-t border-line-soft px-3 py-2 text-xs text-fg-3">
        <span aria-live="polite">{selected.length ? `${selected.length} selected` : 'None selected'}</span>
        <span className="flex-1" />
        <KeyHint keys="↵">{config.multiple ? 'apply' : 'pick'}</KeyHint>
        <KeyHint keys="Esc">{escLabel}</KeyHint>
      </div>
    </div>
  );
}

/** Submenu content: closes its own submenu on Esc (back), the whole menu after a one-value pick. */
function SubmenuValues({
  backTo,
  ...props
}: Omit<FilterValuesPanelProps, 'onBack'> & { backTo: RefObject<HTMLInputElement | null> }) {
  const submenu = useContext(OverlayTriggerStateContext);
  return (
    <FilterValuesPanel
      {...props}
      onBack={() => {
        submenu?.close();
        // The fields list moves a virtual focus, so focus goes back to its search field.
        requestAnimationFrame(() => backTo.current?.focus());
      }}
    />
  );
}

export interface FilterMenuProps {
  /** Fields and their options: useProjectFilterFields(), or buildFilterFields() on Home. */
  fields: readonly FilterFieldConfig[];
  filter: TaskFilter;
  onChange: (filter: TaskFilter) => void;
  /** The trigger: a kit Button (or another React Aria pressable). */
  children: ReactNode;
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  /** Anchor when it differs from the trigger. */
  triggerRef?: RefObject<Element | null>;
}

/** The fields list ("Filter by…") with a values submenu per field, under its trigger. */
export function FilterMenu({
  fields,
  filter,
  onChange,
  children,
  isOpen,
  onOpenChange,
  triggerRef,
}: FilterMenuProps) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = isOpen ?? innerOpen;
  const setOpen = (next: boolean) => {
    if (isOpen === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };
  const { contains } = useFilter({ sensitivity: 'base' });
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  return (
    <MenuTrigger isOpen={open} onOpenChange={setOpen}>
      {children}
      <Popover
        placement="bottom start"
        offset={8}
        {...(triggerRef ? { triggerRef } : {})}
        className="min-w-0 overflow-hidden"
        style={{ width: FIELDS_WIDTH }}
      >
        <div ref={panelRef} className="flex flex-col">
          <Autocomplete filter={contains}>
            <SearchField aria-label="Filter by" autoFocus className={searchClass}>
              <Input ref={searchRef} placeholder="Filter by…" className={inputClass} />
            </SearchField>
            <AriaMenu
              aria-label="Filter by"
              className="flex max-h-90 flex-col gap-px overflow-auto p-1.5 outline-none"
              renderEmptyState={() => <div className="px-2 py-1.5 text-sm text-fg-3">No matching field</div>}
            >
              {fields.map((config) => (
                <SubmenuTrigger key={config.field}>
                  <AriaMenuItem id={config.field} textValue={config.label} className={itemClass}>
                    <span className="min-w-0 flex-1 truncate">{config.label}</span>
                    <span aria-hidden className="text-xs text-fg-3">
                      ›
                    </span>
                  </AriaMenuItem>
                  <Popover
                    // Top-aligned with the fields list, 8px to its right (frame 047).
                    triggerRef={panelRef}
                    placement="end top"
                    offset={8}
                    className="min-w-0 overflow-hidden"
                    style={{ width: VALUES_WIDTH }}
                  >
                    <SubmenuValues
                      config={config}
                      filter={filter}
                      onChange={onChange}
                      onDone={() => setOpen(false)}
                      backTo={searchRef}
                    />
                  </Popover>
                </SubmenuTrigger>
              ))}
            </AriaMenu>
          </Autocomplete>
        </div>
      </Popover>
    </MenuTrigger>
  );
}

export interface FieldFilterPopoverProps {
  config: FilterFieldConfig;
  filter: TaskFilter;
  onChange: (filter: TaskFilter) => void;
  /** The trigger (a chip's value), or omit and pass triggerRef with isOpen (opened from the palette). */
  children?: ReactNode;
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  triggerRef?: RefObject<Element | null>;
}

/** One field's values in their own popover: a chip's value, or "Filter by label…" from the palette. */
export function FieldFilterPopover({
  config,
  filter,
  onChange,
  children,
  isOpen,
  onOpenChange,
  triggerRef,
}: FieldFilterPopoverProps) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = isOpen ?? innerOpen;
  const setOpen = (next: boolean) => {
    if (isOpen === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };
  const popover = (
    <Popover
      placement="bottom start"
      offset={8}
      {...(triggerRef ? { triggerRef } : {})}
      isOpen={children ? undefined : open}
      onOpenChange={children ? undefined : setOpen}
      className="min-w-0 overflow-hidden"
      style={{ width: VALUES_WIDTH }}
    >
      <FilterValuesPanel
        config={config}
        filter={filter}
        onChange={onChange}
        onBack={() => setOpen(false)}
        onDone={() => setOpen(false)}
        escLabel="close"
      />
    </Popover>
  );
  if (!children) return popover;
  return (
    <MenuTrigger isOpen={open} onOpenChange={setOpen}>
      {children}
      {popover}
    </MenuTrigger>
  );
}

export interface FilterButtonProps {
  fields: readonly FilterFieldConfig[];
  filter: TaskFilter;
  onChange: (filter: TaskFilter) => void;
  className?: string;
}

/**
 * The view header's Filter button (frame 046): quiet, with the filters glyph, "on" while the menu
 * is open. Opens from the palette too (requestFilterMenu()).
 */
export function FilterButton({ fields, filter, onChange, className }: FilterButtonProps) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<FilterField | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  useViewRequests((request) => {
    if (request.kind !== 'filter') return;
    if (request.field && fields.some((config) => config.field === request.field)) {
      setOpen(false);
      setField(request.field);
    } else {
      setField(null);
      setOpen(true);
    }
  });
  const fieldConfig = field ? fields.find((config) => config.field === field) : undefined;
  return (
    <>
      <span ref={anchorRef} className="inline-flex">
        <FilterMenu fields={fields} filter={filter} onChange={onChange} isOpen={open} onOpenChange={setOpen}>
          <Button variant="quiet" className={cn((open || field) && 'bg-bg-lane text-fg', className)}>
            <FiltersGlyph />
            Filter
          </Button>
        </FilterMenu>
      </span>
      {fieldConfig ? (
        <FieldFilterPopover
          config={fieldConfig}
          filter={filter}
          onChange={onChange}
          triggerRef={anchorRef}
          isOpen
          onOpenChange={(next) => {
            if (!next) setField(null);
          }}
        />
      ) : null}
    </>
  );
}

export interface FilterChipsProps {
  fields: readonly FilterFieldConfig[];
  filter: TaskFilter;
  onChange: (filter: TaskFilter) => void;
  /** Tasks matching the filter ("21 of 123 tasks"). Omit while unknown. */
  matchCount?: number;
  /** Tasks in the view without filters. */
  total?: number;
  className?: string;
}

/**
 * The row under the header while filters are set (frame 013): a chip per field (its value opens
 * the field's values, × removes it), + Filter, the match count and Clear. Renders nothing when no
 * field is set.
 */
export function FilterChips({ fields, filter, onChange, matchCount, total, className }: FilterChipsProps) {
  const active = activeFilterFields(filter);
  const [adding, setAdding] = useState(false);
  if (active.length === 0) return null;
  const count =
    matchCount === undefined
      ? null
      : filter.archived === 'only'
        ? // M7 frame 083: the archived view counts what it shows.
          `${matchCount} archived ${matchCount === 1 ? 'task' : 'tasks'}`
        : total === undefined
          ? `${matchCount} ${matchCount === 1 ? 'task' : 'tasks'}`
          : `${matchCount} of ${total} ${total === 1 ? 'task' : 'tasks'}`;
  return (
    <div
      role="toolbar"
      aria-label="Filters"
      className={cn(
        'flex h-10.5 shrink-0 items-center gap-1.5 border-b border-line-soft pr-3.5 pl-4.5',
        className,
      )}
    >
      {active.map((field) => {
        const config = fields.find((item) => item.field === field);
        if (!config) return null;
        const ids = fieldValues(filter, field);
        const words = chipText(config, ids);
        return (
          <span
            key={field}
            data-filter-chip={field}
            className="inline-flex h-6.5 shrink-0 items-center overflow-hidden rounded-pill bg-bg-lane text-sm"
          >
            <FieldFilterPopover config={config} filter={filter} onChange={onChange}>
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
              onPress={() => onChange(withoutField(filter, field))}
              className="inline-flex h-full cursor-pointer items-center border-l border-line pr-2.25 pl-1.5 text-fg-3 outline-none hover:bg-line-soft hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
            >
              <CloseGlyph />
            </AriaButton>
          </span>
        );
      })}
      <FilterMenu
        fields={fields}
        filter={filter}
        onChange={onChange}
        isOpen={adding}
        onOpenChange={setAdding}
      >
        <Button variant="quiet" size="sm" aria-label="Add a filter">
          <PlusGlyph />
          Filter
        </Button>
      </FilterMenu>
      <span className="flex-1" />
      {count ? <span className="text-sm whitespace-nowrap text-fg-3">{count}</span> : null}
      <Button
        variant="ghost"
        size="sm"
        className="text-sm text-accent-text"
        onPress={() => onChange(clearedFilter(filter))}
      >
        Clear
      </Button>
    </div>
  );
}
