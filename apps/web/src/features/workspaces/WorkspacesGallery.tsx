// /__ui, workspaces (PM-39): the switcher open with two workspaces, the New workspace dialog (empty,
// suggested, taken), General settings for an owner and for a member, the Leave refusals, the Delete
// confirm, /welcome with and without the right to create, and the Home of a new workspace. Once per
// theme. Only the presentational pieces: nothing here calls the server.
import type { ReactNode } from 'react';
import { Menu as AriaMenu } from 'react-aria-components';
import { workspaceMenuItems } from '~/features/shell/menus';
import { Button, cn, DialogBody, DialogFooter, DialogHeader, DialogSurface } from '~/ui';
import { RefusalNote } from './ConfirmAction';
import { DeleteContent, DeleteRow, LEAVE_TEXT, LeaveRow, WorkspaceForm } from './GeneralParts';
import { NewWorkspaceForm } from './NewWorkspace';
import { NewWorkspaceStart } from './NewWorkspaceStart';
import { WelcomeContent } from './Welcome';

const noop = () => {};
const resolved = async () => null;

const ACME = { id: 'w1', name: 'Acme', slug: 'acme' };
const GLOBEX = { id: 'w2', name: 'Globex', slug: 'globex' };
const ANA = { name: 'Ana Ruiz', email: 'ana@example.com' };

export function WorkspacesGallery() {
  return (
    <section aria-label="Workspaces" data-frame="workspaces" className="flex flex-col">
      <WorkspacesFrame theme="light" />
      <WorkspacesFrame theme="dark" />
    </section>
  );
}

function WorkspacesFrame({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <div
      id={`workspaces-${theme}`}
      data-frame={`workspaces-${theme}`}
      className={cn(
        theme,
        'grid w-[1440px] grid-cols-3 gap-x-10 gap-y-9 border-t border-line bg-bg px-10 pt-8 pb-10 font-sans text-md text-fg',
      )}
    >
      <div className="col-span-3 flex items-baseline gap-4">
        <h2 className="m-0 font-serif text-2xl font-medium">Workspaces</h2>
        <span className="text-fg-3">{theme}</span>
      </div>

      <Sec title="Switcher, open (frame 004)">
        <div className="w-58 rounded-lg bg-surface-pop text-sm text-fg shadow-pop">
          <AriaMenu aria-label={`Workspace (${theme})`} className="flex flex-col gap-px p-1.5 outline-none">
            {workspaceMenuItems({
              current: ACME,
              workspaces: [ACME, GLOBEX],
              canCreate: true,
              workspaceHref: (slug) => `#${slug}`,
              settingsHref: '#settings',
              inviteHref: '#invite',
              onNewWorkspace: noop,
            })}
          </AriaMenu>
        </div>
        <Cap>WORKSPACE_CREATION=owners hides New workspace for people who own none.</Cap>
      </Sec>

      <Sec title="New workspace, suggested from the name">
        <DialogSurface width={440}>
          <NewWorkspaceForm
            autoFocus={false}
            onSubmit={resolved}
            onCancel={noop}
            initial={{ name: 'Acme Corp' }}
          />
        </DialogSurface>
      </Sec>

      <Sec title="New workspace, address taken">
        <DialogSurface width={440}>
          <NewWorkspaceForm
            autoFocus={false}
            onSubmit={resolved}
            onCancel={noop}
            initial={{
              name: 'Globex',
              slug: 'globex',
              errors: { slug: 'The address globex is taken. Pick another.' },
            }}
          />
        </DialogSurface>
      </Sec>

      <Sec title="General, owner" full>
        <div className="flex max-w-180 flex-col gap-7 rounded-lg border border-line-soft p-7">
          <WorkspaceForm workspace={ACME} canEdit onSubmit={resolved} />
          <LeaveRow name="Acme" onLeave={noop} />
          <DeleteRow name="Acme" onDelete={noop} />
        </div>
      </Sec>

      <Sec title="General, member">
        <div className="flex flex-col gap-7 rounded-lg border border-line-soft p-5">
          <WorkspaceForm workspace={GLOBEX} canEdit={false} onSubmit={resolved} />
        </div>
      </Sec>

      <Sec title="Leave, refused for the last owner">
        <Confirm title="Leave Acme?">
          <RefusalNote
            refusal={{
              message: "You are the only owner of Acme, so you can't leave it. Delete the workspace instead.",
              agents: [],
            }}
          />
        </Confirm>
        <Cap>Before the refusal: {LEAVE_TEXT}</Cap>
      </Sec>

      <Sec title="Leave, refused while responsible for agents">
        <Confirm title="Leave Acme?">
          <RefusalNote
            refusal={{
              message:
                'You are responsible for claude-dev and codex-ci here. Hand them to someone else or remove them first.',
              agents: ['claude-dev', 'codex-ci'],
            }}
          />
        </Confirm>
      </Sec>

      <Sec title="Delete, counts and typed slug">
        <DialogSurface width={440}>
          <DeleteContent
            autoFocus={false}
            name="Acme"
            slug="acme"
            contents={{ projects: 3, tasks: 120, agents: 2, keys: 4 }}
            initialTyped="acme"
            onDelete={resolved}
            close={noop}
          />
        </DialogSurface>
      </Sec>

      <Sec title="Delete, counting">
        <DialogSurface width={440}>
          <DeleteContent
            autoFocus={false}
            name="Globex"
            slug="globex"
            contents={undefined}
            onDelete={resolved}
            close={noop}
          />
        </DialogSurface>
      </Sec>

      <Sec title="/welcome, may create">
        <div className="flex max-w-100 flex-col gap-4.5">
          <WelcomeContent canCreate user={ANA} onSignOut={noop} onCreate={resolved} />
        </div>
      </Sec>

      <Sec title="/welcome, WORKSPACE_CREATION=owners">
        <div className="flex max-w-100 flex-col gap-4.5">
          <WelcomeContent canCreate={false} user={ANA} onSignOut={noop} onCreate={resolved} />
        </div>
      </Sec>

      <Sec title="Home of a new workspace" full>
        <div className="rounded-lg border border-line-soft">
          <NewWorkspaceStart
            workspaceName="Acme"
            onNewProject={noop}
            onNewFromBacklog={noop}
            onAddAgent={noop}
          />
        </div>
      </Sec>
    </div>
  );
}

/** A refused confirm as the dialog draws it: the refusal and Close. */
function Confirm({ title, children }: { title: string; children: ReactNode }) {
  return (
    <DialogSurface width={440}>
      <DialogHeader title={title} showEsc={false} className="pt-4.5" />
      <DialogBody>{children}</DialogBody>
      <DialogFooter>
        <Button variant="secondary">Close</Button>
      </DialogFooter>
    </DialogSurface>
  );
}

function Sec({ title, full, children }: { title: string; full?: boolean; children: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-3', full && 'col-span-2')}>
      <div className="text-sm font-semibold text-fg-3">{title}</div>
      {children}
    </div>
  );
}

function Cap({ children }: { children: ReactNode }) {
  return <span className="text-xs text-fg-3">{children}</span>;
}
