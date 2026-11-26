import { useQuery } from '@tanstack/react-query';
import type { Member } from '@zamu/contracts';
import { AgentCreation } from '~/features/settings/CreationFlows';
import { membersQuery, meQuery, projectsQuery, useCreateAgent } from '~/features/settings/queries';
import { useApi } from '~/lib/workspace';
import type { AgentSuggestion } from './agent-suggestions';

// Add agent from the Mappings step, wired to the server: prefilled with the assignee's name, the
// signed-in admin as responsible human and a key for this project only. The key reveal stays
// mounted after the form closes, so the host is always rendered.

export interface CreateAgentHostProps {
  /** The agent to create; null keeps the dialog closed. */
  draft: AgentSuggestion | null;
  projectId: string;
  onClose: () => void;
  /** The agent exists; map the draft's values to it. */
  onCreated: (draft: AgentSuggestion, agent: Member) => void;
}

export function CreateAgentHost({ draft, projectId, onClose, onCreated }: CreateAgentHostProps) {
  const api = useApi();
  // The form reads its defaults once, on open, so it waits for the people and projects it offers.
  const me = useQuery(meQuery(api));
  const members = useQuery(membersQuery(api));
  const projects = useQuery(projectsQuery(api));
  const isOpen = draft !== null && Boolean(me.data && members.data && projects.data);
  const createAgent = useCreateAgent();
  const people = members.data?.items.filter((member) => member.kind === 'person') ?? [];

  return (
    <AgentCreation
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      people={people}
      defaultResponsibleId={me.data?.user.id ?? ''}
      projects={projects.data?.items ?? []}
      onSubmit={createAgent}
      onCreated={({ agent }) => {
        if (draft) onCreated(draft, agent);
      }}
      defaultName={draft?.name}
      defaultScope={{ access: 'selected', projectIds: [projectId], permission: 'write' }}
      nameDescription={
        draft ? `From ${draft.from.join(', ')} in the files. Lowercase, numbers and dashes.` : undefined
      }
    />
  );
}
