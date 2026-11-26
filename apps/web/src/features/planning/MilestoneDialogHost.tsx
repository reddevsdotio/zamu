import { useNavigate } from '@tanstack/react-router';
import type { MilestoneWithProgress } from '@zamu/contracts';
import { useWorkspaceSlug } from '~/lib/workspace';
import { writeFailure } from './errors';
import { MilestoneDialog, type MilestoneField, type MilestoneValues } from './MilestoneDialog';
import { useCreateMilestone, useDeleteMilestone, useUpdateMilestone } from './queries';

// The milestone dialogs wired to the API.

const FIELDS: readonly MilestoneField[] = ['name', 'description', 'targetDate'];

const nameTaken = (name: string, projectKey: string) => ({
  field: 'name' as const,
  message: `${projectKey} already has a milestone named “${name}”. Pick another name.`,
});

export interface NewMilestoneDialogProps {
  projectKey: string;
  isOpen: boolean;
  onClose: () => void;
  today: string;
}

export function NewMilestoneDialog({ projectKey, isOpen, onClose, today }: NewMilestoneDialogProps) {
  const create = useCreateMilestone();
  const onSubmit = async (values: MilestoneValues) => {
    try {
      await create.mutateAsync({
        project: projectKey,
        name: values.name,
        description: values.description,
        targetDate: values.targetDate,
      });
    } catch (error) {
      return writeFailure(error, FIELDS, 'milestone', nameTaken(values.name, projectKey));
    }
    onClose();
    return null;
  };
  return (
    <MilestoneDialog
      isOpen={isOpen}
      onClose={onClose}
      projectKey={projectKey}
      today={today}
      onSubmit={onSubmit}
    />
  );
}

export interface EditMilestoneDialogProps extends NewMilestoneDialogProps {
  milestone: MilestoneWithProgress;
}

export function EditMilestoneDialog({
  projectKey,
  milestone,
  isOpen,
  onClose,
  today,
}: EditMilestoneDialogProps) {
  const workspace = useWorkspaceSlug();
  const update = useUpdateMilestone();
  const remove = useDeleteMilestone();
  const navigate = useNavigate();

  const onSubmit = async (values: MilestoneValues) => {
    const changes = {
      ...(values.name !== milestone.name ? { name: values.name } : {}),
      ...(values.description !== milestone.description ? { description: values.description } : {}),
      ...(values.targetDate !== milestone.targetDate ? { targetDate: values.targetDate } : {}),
      ...(values.status && values.status !== milestone.status ? { status: values.status } : {}),
    };
    if (Object.keys(changes).length) {
      try {
        await update.mutateAsync({ id: milestone.id, ...changes });
      } catch (error) {
        return writeFailure(error, FIELDS, 'milestone', nameTaken(values.name, projectKey));
      }
    }
    onClose();
    return null;
  };

  const onDelete = async () => {
    try {
      await remove.mutateAsync(milestone.id);
    } catch (error) {
      return writeFailure(error, FIELDS, 'milestone').message.replace("Couldn't save", "Couldn't delete");
    }
    onClose();
    void navigate({ to: '/w/$workspace/p/$projectKey/milestones', params: { workspace, projectKey } });
    return null;
  };

  return (
    <MilestoneDialog
      isOpen={isOpen}
      onClose={onClose}
      projectKey={projectKey}
      milestone={milestone}
      today={today}
      onSubmit={onSubmit}
      onDelete={onDelete}
    />
  );
}
