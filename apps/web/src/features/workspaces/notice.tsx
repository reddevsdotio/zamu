// "You left Acme.", "Deleted Acme.", "Acme now lives at /w/acme-corp.": the General page navigates away
// (or to the new address) right after the change, so the toast waits in a module store for the next
// page that renders WorkspaceNoticeToast (the shell and /welcome), like the Deleted project toast.
import { useSyncExternalStore } from 'react';
import { Toast } from '~/ui';

export const WORKSPACE_NOTICE_MS = 6_000;

interface Notice {
  id: number;
  text: string;
  at: number;
}

let notice: Notice | null = null;
let nextId = 0;
const listeners = new Set<() => void>();

function setNotice(next: Notice | null) {
  notice = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Queues `text` for the next page that renders WorkspaceNoticeToast. */
export function announceWorkspace(text: string, now: number = Date.now()): void {
  nextId += 1;
  setNotice({ id: nextId, text, at: now });
}

/** The queued notice, once, for a change of the last few seconds. */
export function WorkspaceNoticeToast() {
  const current = useSyncExternalStore(
    subscribe,
    () => notice,
    () => null,
  );
  if (!current || Date.now() - current.at > WORKSPACE_NOTICE_MS) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-6">
      <Toast
        key={current.id}
        timeout={WORKSPACE_NOTICE_MS}
        onDismiss={() => {
          if (notice?.id === current.id) setNotice(null);
        }}
        className="pointer-events-auto"
      >
        {current.text}
      </Toast>
    </div>
  );
}
