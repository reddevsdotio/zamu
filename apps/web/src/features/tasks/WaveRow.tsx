import { useQuery } from '@tanstack/react-query';
import type { Task } from '@zamu/contracts';
import { useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { milestonePlanQuery } from '~/features/planning/queries';
import { useFieldChange } from '~/features/task-fields';
import { useApi } from '~/lib/workspace';
import { cn, LockGlyph, Menu, MenuItem, MenuSeparator, MenuTrigger, WaveNumber } from '~/ui';

// The task view's Wave row (M8), under Milestone: "W3 · Screens", with the lock and "Locked until W2
// passes" while an earlier gate has not passed. A press lists the waves of the task's milestone (read
// from its plan when the menu opens) and "No wave". Picking one goes through useFieldChange, with the
// toast and its Undo. Waves are Zamu's own data, so mirrored tasks may change it; archived ones don't.

const rowClass =
  'group relative -mx-1.5 grid min-h-8 w-[calc(100%+12px)] grid-cols-[92px_minmax(0,1fr)] items-start gap-2 rounded-sm px-1.5 py-1.5 text-left';

const NO_WAVE = 'none';

export function WaveRow({ task, archived }: { task: Task; archived: boolean }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const milestoneId = task.milestone?.id ?? '';
  const plan = useQuery({ ...milestonePlanQuery(api, milestoneId), enabled: open && milestoneId !== '' });
  const { apply } = useFieldChange();
  const wave = task.wave ?? null;
  const until = wave?.locked ? wave.lockedUntil : null;

  const value = wave ? (
    <span className="flex min-w-0 basis-full flex-col gap-1">
      <span className="flex min-w-0 items-center gap-1.75">
        <WaveNumber locked={wave.locked}>W{wave.number}</WaveNumber>
        <span className="truncate">{wave.name}</span>
        {wave.locked ? <LockGlyph className="shrink-0 text-fg-3" aria-hidden /> : null}
      </span>
      {wave.locked ? (
        <span className="text-xs font-normal text-fg-3">
          {until ? `Locked until W${until.number} passes` : 'Locked'}
        </span>
      ) : null}
    </span>
  ) : (
    <span className="font-normal text-fg-3">{archived ? 'None' : 'Add to a wave'}</span>
  );

  const label = (
    <>
      <span className="text-sm leading-5 text-fg-3">Wave</span>
      <span className="flex min-h-5 min-w-0 flex-wrap items-center gap-1.75 pr-5 text-md font-medium text-fg">
        {value}
      </span>
    </>
  );

  if (archived) {
    return (
      <div className={rowClass} data-field="wave">
        {label}
      </div>
    );
  }

  const pick = (key: string) => {
    if (key === NO_WAVE) {
      void apply([task], { wave: null });
      return;
    }
    const picked = plan.data?.waves.find((item) => item.id === key);
    if (!picked) return;
    void apply([task], {
      wave: {
        id: picked.id,
        number: picked.number,
        name: picked.name,
        locked: picked.locked,
        lockedUntil: picked.lockedUntil,
      },
    });
  };

  return (
    <MenuTrigger isOpen={open} onOpenChange={setOpen}>
      <AriaButton
        aria-label={wave ? `Wave, W${wave.number} · ${wave.name}${wave.locked ? ', locked' : ''}` : 'Wave'}
        data-field="wave"
        className={cn(
          rowClass,
          'cursor-pointer outline-none hover:bg-bg-grp focus-visible:shadow-[var(--focus-ring)]',
          open && 'bg-bg-grp',
        )}
      >
        {label}
      </AriaButton>
      <Menu
        aria-label="Waves of the milestone"
        placement="bottom end"
        onAction={(key) => pick(String(key))}
        disabledKeys={plan.data ? [] : ['loading']}
      >
        {plan.data ? (
          plan.data.waves.map((item) => (
            <MenuItem
              key={item.id}
              id={item.id}
              textValue={`W${item.number} · ${item.name}`}
              lead={item.locked ? <LockGlyph className="text-fg-3" /> : null}
            >
              W{item.number} · {item.name}
              {item.id === wave?.id ? <span className="sr-only"> (current)</span> : null}
            </MenuItem>
          ))
        ) : (
          <MenuItem id="loading">{plan.isError ? 'Couldn’t load the waves' : 'Loading the waves…'}</MenuItem>
        )}
        <MenuSeparator />
        <MenuItem id={NO_WAVE} isDisabled={wave == null}>
          No wave
        </MenuItem>
      </Menu>
    </MenuTrigger>
  );
}
