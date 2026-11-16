// The owner's queue of messages waiting for the end of the agent's turn.

/** The ids in their new order after moving the message at `index` one place (`-1` earlier, `1` later). */
export function moveQueued(messages: ReadonlyArray<{ id: string }>, index: number, step: -1 | 1): string[] {
  const ids = messages.map((message) => message.id)
  const target = index + step
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return ids
  const moved = ids[index] as string
  ids[index] = ids[target] as string
  ids[target] = moved
  return ids
}

/**
 * What the request body adds for a message sent while the task works: Enter queues it for the end of the turn, the
 * second way (⌘/Ctrl+Enter, the bolt button) hands it to the working agent now.
 */
export function deliveryRequest(working: boolean, now: boolean): { queue?: true } {
  return working && !now ? { queue: true } : {}
}
