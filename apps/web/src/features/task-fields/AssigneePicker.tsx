import { useQuery } from '@tanstack/react-query';
import type { AssigneeRef, Member } from '@zamu/contracts';
import { membersQuery, meQuery } from '~/features/tasks/queries';
import { useApi } from '~/lib/workspace';
import { Avatar, PickerMenu, type PickerMenuItem, type PickerMenuSection, UnassignedAvatar } from '~/ui';
import { useFieldChange } from './apply';
import type { FieldPickerProps } from './StatusPicker';
import { commonValue, FieldPopover, firstName, READ_ONLY_HINTS, ReadOnlyLine } from './shared';
import { fieldRefusal, toTargets } from './targets';

// Assignee (frame 077): No assignee (0), you first, the other people, then agents "for Ana".

const NONE = '__none__';

/** A member as a task's assignee. */
export function toAssigneeRef(member: Pick<Member, 'id' | 'name' | 'kind' | 'responsible'>): AssigneeRef {
  return { id: member.id, name: member.name, kind: member.kind, responsible: member.responsible };
}

export interface AssigneeMenuProps {
  /** The current assignee, null for none, `mixed` when the selected tasks differ. */
  value: AssigneeRef | null | 'mixed';
  members: readonly Member[] | undefined;
  /** The signed-in member, drawn first with "you". */
  meId?: string;
  onChange: (assignee: AssigneeRef | null) => void;
  readOnly?: boolean;
  /** Why it is read-only (defaults to the Backlog.md lock text). */
  readOnlyText?: string;
  onClose?: () => void;
  autoFocus?: boolean;
}

export function AssigneeMenu({
  value,
  members,
  meId,
  onChange,
  readOnly = false,
  readOnlyText,
  onClose,
  autoFocus,
}: AssigneeMenuProps) {
  const all = members ?? [];
  const people = all
    .filter((member) => member.kind === 'person')
    .sort((a, b) => Number(b.id === meId) - Number(a.id === meId) || a.name.localeCompare(b.name));
  const agents = all.filter((member) => member.kind === 'agent').sort((a, b) => a.name.localeCompare(b.name));
  const item = (member: Member): PickerMenuItem => ({
    id: member.id,
    label: member.name,
    lead: <Avatar name={member.name} kind={member.kind} decorative />,
    sub:
      member.id === meId
        ? 'you'
        : member.responsible
          ? `for ${firstName(member.responsible.name)}`
          : undefined,
    textValue: member.responsible ? `${member.name} ${member.responsible.name}` : member.name,
    isDisabled: readOnly,
  });
  const sections: PickerMenuSection[] = [
    {
      id: 'people',
      items: [
        {
          id: NONE,
          label: 'No assignee',
          lead: <UnassignedAvatar decorative />,
          numberKey: '0',
          isDisabled: readOnly,
        },
        ...people.map(item),
      ],
    },
    ...(agents.length ? [{ id: 'agents', title: 'Agents', items: agents.map(item) }] : []),
  ];
  const selected = value === 'mixed' ? [] : [value?.id ?? NONE];
  return (
    <PickerMenu
      aria-label="Assignee"
      sections={sections}
      selectedKeys={selected}
      onAction={(id) => {
        if (id === NONE) return onChange(null);
        const member = all.find((candidate) => candidate.id === id);
        if (member) onChange(toAssigneeRef(member));
      }}
      numberKeys={!readOnly}
      search={{ placeholder: 'Assign to…', kbd: 'A' }}
      emptyText={members ? 'No one by that name' : 'Loading members…'}
      before={readOnly ? <ReadOnlyLine>{readOnlyText}</ReadOnlyLine> : undefined}
      footer={{
        hints: readOnly
          ? READ_ONLY_HINTS
          : [
              { keys: '↵', label: 'assign' },
              { keys: 'Esc', label: 'close' },
            ],
      }}
      onClose={onClose}
      autoFocus={autoFocus}
    />
  );
}

export function AssigneePicker({ targets, onChanged, ...anchor }: FieldPickerProps) {
  const api = useApi();
  const list = toTargets(targets);
  const { apply } = useFieldChange();
  const members = useQuery(membersQuery(api)).data?.items;
  const meId = useQuery(meQuery(api)).data?.user.id;
  const reason = fieldRefusal(list, 'assignee');
  return (
    <FieldPopover label="Assignee" width={274} {...anchor}>
      {(close) => (
        <AssigneeMenu
          value={commonValue(
            list,
            (task) => task.assignee,
            (a, b) => (a?.id ?? null) === (b?.id ?? null),
          )}
          members={members}
          meId={meId}
          readOnly={reason != null}
          readOnlyText={reason ?? undefined}
          onClose={close}
          onChange={(assignee) => {
            void apply(list, { assignee });
            onChanged?.();
          }}
        />
      )}
    </FieldPopover>
  );
}
