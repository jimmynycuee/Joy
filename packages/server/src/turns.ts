// Owner rounds of a task, read from its stored events: the queue of messages still waiting for the agent (so it
// survives a restart), the parts of the thread the owner went back over ("rewound"), and the rounds the owner can go
// back to. Pure functions over events; the server owns the side effects.

/** The parts of a stored task event these functions read. */
export interface TurnEvent {
  seq: number
  type: string
  payload: unknown
}

/** An owner message still waiting for the agent, as recorded in the events. */
export interface PendingMessage {
  id: string
  text: string
  attachments?: string[]
  settings?: unknown
}

/** A round the owner can go back to: the worktree as it was before the agent started on it. */
export interface RewindPoint {
  /** `task` for the first round (the task's own prompt), else the id of the round's first owner message. */
  messageId: string
  /** Owner messages the round started with (several when queued messages went out together). */
  ids: string[]
  /** The checkpoint taken when the round's run started. */
  checkpoint: number
  /** The round's first event: going back discards it and everything after it. */
  fromSeq: number
}

/** The first round of a task is its own prompt, which has no message id. */
export const TASK_ROUND = 'task'

/** Deliveries that start a run of their own (a round) rather than reaching a run already going. */
const ROUND_DELIVERIES = new Set(['follow_up', 'replan'])
/** Deliveries that wait for the agent until a `user.message.delivered` says otherwise. */
const WAITING_DELIVERIES = new Set(['queued', 'steer', 'interrupt'])

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function ids(payload: unknown): string[] {
  const list = record(payload).ids
  return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []
}

function attachmentIds(payload: unknown): string[] | undefined {
  const list = record(payload).attachments
  if (!Array.isArray(list)) return undefined
  const found = list
    .map((item) => (typeof item === 'string' ? item : record(item).id))
    .filter((id): id is string => typeof id === 'string')
  return found.length ? found : undefined
}

/** The seq ranges `[from, to)` the owner discarded by going back to an earlier round. */
export function rewoundRanges(events: readonly TurnEvent[]): Array<{ from: number; to: number }> {
  return events
    .filter((event) => event.type === 'task.rewound')
    .map((event) => ({ from: Number(record(event.payload).fromSeq), to: event.seq }))
    .filter((range) => Number.isFinite(range.from) && range.from < range.to)
}

/** Message ids the owner discarded by going back (some were sent before the range, then delivered in it). */
function rewoundIds(events: readonly TurnEvent[]): Set<string> {
  const found = new Set<string>()
  for (const event of events)
    if (event.type === 'task.rewound') {
      const list = record(event.payload).discardedIds
      if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') found.add(id)
    }
  return found
}

/**
 * The thread as it stands: events in discarded ranges and the owner messages discarded with them are left out, and
 * every owner message carries its latest edit.
 */
export function effectiveEvents<T extends TurnEvent>(events: readonly T[]): T[] {
  const ranges = rewoundRanges(events)
  const dropped = rewoundIds(events)
  const edits = new Map<string, string>()
  for (const event of events)
    if (event.type === 'user.message.edited') {
      const { id, text } = record(event.payload)
      if (typeof id === 'string' && typeof text === 'string') edits.set(id, text)
    }
  const result: T[] = []
  for (const event of events) {
    if (ranges.some((range) => event.seq >= range.from && event.seq < range.to)) continue
    if (event.type === 'user.message') {
      const payload = record(event.payload)
      const id = typeof payload.id === 'string' ? payload.id : undefined
      if (id && dropped.has(id)) continue
      const edited = id ? edits.get(id) : undefined
      result.push(edited === undefined ? event : { ...event, payload: { ...payload, text: edited } })
      continue
    }
    result.push(event)
  }
  return result
}

/**
 * The owner messages still waiting for the agent, in the order it will get them, replayed from the events: sent to a
 * busy task, minus those delivered or discarded since, with the owner's edits and reorders. A steer that was still on
 * its way when Joy stopped counts as waiting: nothing recorded that the agent got it.
 *
 * Only messages marked `persisted` count: versions before it kept the queue in memory and wrote nothing when a restart
 * lost it. And a message that saw a later run start without being delivered or discarded is taken as lost too (each
 * run takes the queue right after it starts), so a stale instruction never joins a new follow-up.
 */
export function pendingMessages(events: readonly TurnEvent[]): PendingMessage[] {
  const waiting = new Map<string, PendingMessage>()
  let order: string[] = []
  /** Waiting when a run started: lost unless that run (or a later event) delivers or discards them. */
  let seenStart = new Set<string>()
  const lostAtStart = new Set<string>()
  const take = (list: string[]) => {
    for (const id of list) waiting.delete(id)
    order = order.filter((id) => waiting.has(id))
  }
  for (const event of events) {
    const payload = record(event.payload)
    switch (event.type) {
      case 'user.message': {
        if (
          typeof payload.id !== 'string' ||
          !WAITING_DELIVERIES.has(String(payload.delivery)) ||
          payload.persisted !== true
        )
          break
        const files = attachmentIds(payload)
        waiting.set(payload.id, {
          id: payload.id,
          text: typeof payload.text === 'string' ? payload.text : '',
          ...(files ? { attachments: files } : {}),
          ...(payload.settings !== undefined ? { settings: payload.settings } : {}),
        })
        order.push(payload.id)
        break
      }
      case 'user.message.requeued':
        // A steer that fell back joins the end of the queue, as the server does.
        for (const id of ids(payload))
          if (waiting.has(id) && payload.reason === 'steer_failed') {
            order = [...order.filter((other) => other !== id), id]
          }
        break
      case 'user.message.delivered':
      case 'user.message.discarded':
        take(ids(payload))
        break
      case 'user.message.edited': {
        const message = typeof payload.id === 'string' ? waiting.get(payload.id) : undefined
        if (message && typeof payload.text === 'string') message.text = payload.text
        break
      }
      case 'user.message.reordered': {
        const wanted = ids(payload).filter((id) => waiting.has(id))
        order = [...wanted, ...order.filter((id) => !wanted.includes(id))]
        break
      }
      case 'task.rewound':
        take([...order])
        break
      case 'started':
        // Still waiting from before the previous run started and that run never took them: lost.
        for (const id of seenStart) if (waiting.has(id)) lostAtStart.add(id)
        seenStart = new Set(order)
        break
      case 'run.interrupted':
        // The next run continues this one and takes the waiting messages then: it does not pass them over.
        seenStart = new Set()
        break
    }
  }
  take([...lostAtStart])
  return order.flatMap((id) => {
    const message = waiting.get(id)
    return message ? [message] : []
  })
}

/**
 * The rounds the owner can go back to, oldest first. A round starts when owner messages start a run (the task itself,
 * a follow-up or plan feedback) and can be gone back to once that run took its turn-start checkpoint. Messages that
 * reached a run already going are part of that run's round.
 */
export function rewindPoints(events: readonly TurnEvent[]): RewindPoint[] {
  const live = effectiveEvents(events)
  const points: RewindPoint[] = []
  // The first round starts at the beginning, or where the owner last went back to it.
  const lastTaskRewind = live.filter(
    (event) => event.type === 'task.rewound' && record(event.payload).messageId === TASK_ROUND,
  )
  const startIndex = lastTaskRewind.length ? live.indexOf(lastTaskRewind.at(-1) as TurnEvent) + 1 : 0
  let open: { messageId: string; ids: string[]; fromSeq: number; started: boolean } | undefined = {
    messageId: TASK_ROUND,
    ids: [],
    fromSeq: live[startIndex]?.seq ?? 0,
    started: false,
  }
  for (const event of live.slice(startIndex)) {
    const payload = record(event.payload)
    if (event.type === 'user.message.delivered' && ROUND_DELIVERIES.has(String(payload.via))) {
      const list = ids(payload)
      if (list.length) open = { messageId: list[0] as string, ids: list, fromSeq: event.seq, started: false }
      continue
    }
    if (
      event.type === 'user.message' &&
      typeof payload.id === 'string' &&
      ROUND_DELIVERIES.has(String(payload.delivery))
    ) {
      // Messages taken from the queue for this round were recorded as delivered just before it.
      if (open && !open.started && open.messageId !== TASK_ROUND && open.fromSeq < event.seq)
        open.ids.push(payload.id)
      else open = { messageId: payload.id, ids: [payload.id], fromSeq: event.seq, started: false }
      continue
    }
    if (event.type === 'started' && open) {
      if (open.started) open = undefined
      else open.started = true
      continue
    }
    if (event.type === 'checkpoint.created' && payload.turnStart === true && open?.started) {
      const n = Number(payload.n)
      if (Number.isInteger(n) && n > 0)
        points.push({ messageId: open.messageId, ids: open.ids, checkpoint: n, fromSeq: open.fromSeq })
      open = undefined
    }
  }
  return points
}
