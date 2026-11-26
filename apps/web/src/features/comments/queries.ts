import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Comment, CommentKind, Timeline, TimelineItem } from '@zamu/contracts';
import type { WorkspaceApi } from '~/lib/orpc';
import { useApi } from '~/lib/workspace';

// Comment and note writes for the task timeline. Each answer from the server goes straight into the cached
// timeline, then the timeline refetches in the background. Deleting is optimistic and rolls back when the
// server refuses; sending and editing wait for the server so a failure keeps the text in the box.

const timelineKey = (api: WorkspaceApi, taskKey: string) =>
  api.orpc.tasks.timeline.queryKey({ input: { key: taskKey } });

function toItem(comment: Comment): TimelineItem {
  return { ...comment, kind: comment.kind === 'note' ? 'note' : 'comment' };
}

const isEntry = (item: TimelineItem) => item.kind === 'comment' || item.kind === 'note';

/** Puts a comment into the cached timeline: replaces it when present, appends it otherwise. */
export function upsertComment(data: Timeline | undefined, comment: Comment): Timeline | undefined {
  if (!data) return data;
  const index = data.items.findIndex((item) => isEntry(item) && item.id === comment.id);
  if (index === -1) return { ...data, items: [...data.items, toItem(comment)] };
  const items = [...data.items];
  items[index] = toItem(comment);
  return { ...data, items };
}

function refresh(api: WorkspaceApi, queryClient: QueryClient, taskKey: string) {
  void queryClient.invalidateQueries({ queryKey: api.orpc.tasks.timeline.key({ input: { key: taskKey } }) });
  void queryClient.invalidateQueries({ queryKey: api.orpc.comments.list.key({ input: { key: taskKey } }) });
}

/** What the composer sends: the text, and (M6) whether it is a work note. */
export type NewComment = string | { body: string; kind?: CommentKind };

export function useCreateComment(taskKey: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: api.orpc.comments.create.mutationKey(),
    mutationFn: (input: NewComment) => {
      const { body, kind } = typeof input === 'string' ? { body: input, kind: undefined } : input;
      return api.client.comments.create({ key: taskKey, body, ...(kind === 'note' ? { kind } : {}) });
    },
    onSuccess: (comment) => {
      queryClient.setQueryData(timelineKey(api, taskKey), (data) => upsertComment(data, comment));
      refresh(api, queryClient, taskKey);
    },
  });
}

export interface UpdateCommentVariables {
  id: string;
  body: string;
}

export function useUpdateComment(taskKey: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: api.orpc.comments.update.mutationKey(),
    mutationFn: ({ id, body }: UpdateCommentVariables) => api.client.comments.update({ id, body }),
    onSuccess: (comment) => {
      queryClient.setQueryData(timelineKey(api, taskKey), (data) => upsertComment(data, comment));
      refresh(api, queryClient, taskKey);
    },
  });
}

export function useDeleteComment(taskKey: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: api.orpc.comments.delete.mutationKey(),
    mutationFn: (id: string) => api.client.comments.delete({ id }),
    onMutate: async (id) => {
      const key = timelineKey(api, taskKey);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData(key);
      const comment = previous?.items.find((item) => isEntry(item) && item.id === id);
      if (comment && comment.kind !== 'activity') {
        queryClient.setQueryData(key, (data) =>
          upsertComment(data, {
            ...comment,
            body: null,
            mentions: [],
            deletedAt: new Date().toISOString(),
          }),
        );
      }
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) queryClient.setQueryData(timelineKey(api, taskKey), context.previous);
    },
    onSuccess: (comment) => {
      queryClient.setQueryData(timelineKey(api, taskKey), (data) => upsertComment(data, comment));
    },
    onSettled: () => refresh(api, queryClient, taskKey),
  });
}
