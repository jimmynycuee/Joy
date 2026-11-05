/** Synthetic messages shaped from the official `codex app-server generate-ts` schema. */
export const syntheticCodexAppServerFixture = {
  thread: { id: 'thread-synthetic-1' },
  rateLimits: {
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: 'codex',
      limitName: 'Codex',
      normalModelSlug: 'gpt-6-luna',
      primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 1_900_000_000 },
      secondary: { usedPercent: 90, windowDurationMins: 10_080, resetsAt: 1_900_100_000 },
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
  },
  commandApproval: {
    method: 'item/commandExecution/requestApproval',
    params: {
      kind: 'command',
      threadId: 'thread-synthetic-1',
      turnId: 'turn-synthetic-1',
      itemId: 'command-1',
      startedAtMs: 1_800_000_000_000,
      environmentId: null,
      reason: 'Command requires approval',
      command: 'echo safe',
      cwd: '/tmp/joy-worktree',
    },
  },
  fileApproval: {
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: 'thread-synthetic-1',
      turnId: 'turn-synthetic-1',
      itemId: 'file-change-1',
      startedAtMs: 1_800_000_000_100,
      reason: 'File change requires approval',
    },
  },
  notifications: [
    {
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          limitId: 'codex',
          limitName: 'Codex',
          normalModelSlug: 'gpt-6-luna',
          primary: null,
          secondary: null,
          rateLimitReachedType: 'rate_limit_reached',
        },
      },
    },
    {
      method: 'item/started',
      params: {
        threadId: 'thread-synthetic-1',
        turnId: 'turn-synthetic-1',
        startedAtMs: 1_800_000_000_200,
        item: {
          type: 'commandExecution',
          id: 'command-1',
          command: 'echo safe',
          cwd: '/tmp/joy-worktree',
          status: 'inProgress',
        },
      },
    },
    {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-synthetic-1',
        turnId: 'turn-synthetic-1',
        itemId: 'command-1',
        delta: 'safe\n',
      },
    },
    {
      method: 'item/completed',
      params: {
        threadId: 'thread-synthetic-1',
        turnId: 'turn-synthetic-1',
        completedAtMs: 1_800_000_000_300,
        item: {
          type: 'commandExecution',
          id: 'command-1',
          command: 'echo safe',
          cwd: '/tmp/joy-worktree',
          status: 'completed',
          aggregatedOutput: 'safe\n',
          exitCode: 0,
        },
      },
    },
    {
      method: 'item/completed',
      params: {
        threadId: 'thread-synthetic-1',
        turnId: 'turn-synthetic-1',
        completedAtMs: 1_800_000_000_400,
        item: {
          type: 'fileChange',
          id: 'file-change-1',
          status: 'completed',
          changes: [
            {
              path: '/tmp/joy-worktree/src/example.ts',
              kind: { type: 'update', move_path: null },
              diff: '...',
            },
          ],
        },
      },
    },
    {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-synthetic-1',
        turnId: 'turn-synthetic-1',
        itemId: 'message-1',
        delta: '{"ok":true}',
      },
    },
    {
      method: 'item/completed',
      params: {
        threadId: 'thread-synthetic-1',
        turnId: 'turn-synthetic-1',
        completedAtMs: 1_800_000_000_500,
        item: {
          type: 'agentMessage',
          id: 'message-1',
          text: '{"ok":true}',
          phase: 'final_answer',
          memoryCitation: null,
          delivery: null,
          questions: null,
        },
      },
    },
    {
      method: 'turn/completed',
      params: {
        threadId: 'thread-synthetic-1',
        turn: {
          id: 'turn-synthetic-1',
          rootTurnId: null,
          items: [],
          itemsView: { type: 'all' },
          status: 'completed',
          error: null,
          startedAt: 1_800_000_000,
          completedAt: 1_800_000_001,
          durationMs: 1000,
        },
      },
    },
  ] satisfies Array<{ method: string; params: unknown }>,
}
