import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { apiToken, request } from '../api.js'
import { record } from '../types.js'
import type { Task, TaskDetails, TaskEvent } from '../types.js'

export function mergeEvents(first: TaskEvent[], second: TaskEvent[]): TaskEvent[] {
  const events = new Map<string, TaskEvent>()
  for (const event of [...first, ...second]) {
    const key =
      event.seq > 0
        ? `sequence:${event.seq}`
        : `ephemeral:${event.eventId ?? `${event.taskId}:${event.type}:${event.ts}:${JSON.stringify(event.payload)}`}`
    if (!events.has(key)) events.set(key, event)
  }
  return [...events.values()].sort((a, b) => {
    if (a.seq > 0 && b.seq > 0) return a.seq - b.seq
    if (a.seq > 0) return -1
    if (b.seq > 0) return 1
    return a.ts.localeCompare(b.ts)
  })
}

/** Events after which the server's derived fields (usage, pending plan, queued messages) are worth asking for again. */
const EXTRAS_EVENTS = new Set([
  'result',
  'error',
  'plan.awaiting_approval',
  'plan.approved',
  'plan.rejected',
  'user.message',
  'user.message.delivered',
  'user.message.discarded',
  'user.message.requeued',
  'user.message.held',
  'run.interrupted',
  'steer.available',
  'started',
  'phase',
  'checks',
  'checkpoint.created',
  'checkpoint.restored',
  'task.updated',
])

/**
 * The parts of the task details the event log does not carry, which the server derives. Merged into the details
 * without touching `events` or `task`, so the live stream's bookkeeping stays intact.
 */
export function withServerFields(current: TaskDetails, next: TaskDetails): TaskDetails {
  return {
    ...current,
    repo: next.repo,
    attempts: next.attempts,
    reviews: next.reviews,
    ...(next.usage ? { usage: next.usage } : {}),
    pendingPlan: next.pendingPlan ?? null,
    queuedMessages: next.queuedMessages ?? [],
    ...(next.steerable !== undefined ? { steerable: next.steerable } : {}),
    ...(next.interruptible !== undefined ? { interruptible: next.interruptible } : {}),
  }
}

/** Whether an event changes what the server derives, so the details are worth fetching again. */
export function changesServerFields(event: TaskEvent): boolean {
  if (EXTRAS_EVENTS.has(event.type)) return true
  // The implementer's session starting or its turn ending changes whether a message reaches it at once.
  if (event.type !== 'agent') return false
  const type = record(record(event.payload)?.event)?.type
  return type === 'session_started' || type === 'done'
}

function taskAfterEvent(task: Task, event: TaskEvent): Task {
  const payload = record(event.payload)
  if (event.type === 'error') return { ...task, status: 'failed' }
  if (event.type !== 'result') return task
  if (payload?.status === 'succeeded')
    return { ...task, status: payload.approved === false ? 'review_ready' : 'done' }
  if (payload?.status === 'failed' || payload?.status === 'cancelled')
    return { ...task, status: payload.status }
  return task
}

/**
 * The selected task with its live event stream. Loads the snapshot over HTTP and follows a WebSocket from the
 * snapshot's last sequence number, reconnecting with backoff; replayed and duplicate events are ignored.
 */
export function useTaskDetails(
  selectedTaskId: string,
  setTasks: Dispatch<SetStateAction<Task[]>>,
  setError: (message: string) => void,
): [TaskDetails | null, Dispatch<SetStateAction<TaskDetails | null>>] {
  const [details, setDetails] = useState<TaskDetails | null>(null)

  useEffect(() => {
    if (!selectedTaskId) {
      setDetails(null)
      return
    }
    let active = true
    let detailsLoaded = false
    let bufferedEvents: TaskEvent[] = []
    let lastAcceptedSequence = 0
    const acceptedOutOfOrder = new Set<number>()
    let snapshotTask: Task | null = null
    let snapshotSequence = -1
    let taskStatusSequence = -1
    let ephemeralFailureSeen = false
    let reconnectAttempts = 0
    let reconnectTimer: number | undefined
    let stableConnectionTimer: number | undefined
    let extrasTimers: number[] = []
    let socket: WebSocket | undefined
    setDetails(null)
    const socketProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    function socketUrl(): string {
      return `${socketProtocol}//${window.location.host}/ws?taskId=${encodeURIComponent(selectedTaskId)}&after=${lastAcceptedSequence}`
    }

    function refreshTaskList(): void {
      void request<{ tasks: Task[] }>('/api/tasks?archived=1')
        .then(({ tasks: updated }) => setTasks(updated))
        .catch(() => {})
    }

    // The server only finishes a run's bookkeeping after the last event, so ask once soon and once a bit later.
    function scheduleExtras(): void {
      for (const timer of extrasTimers) window.clearTimeout(timer)
      extrasTimers = [500, 3000].map((delay) =>
        window.setTimeout(() => {
          void request<TaskDetails>(`/api/tasks/${encodeURIComponent(selectedTaskId)}`)
            .then((next) => {
              if (!active) return
              setDetails((current) =>
                current && current.task.id === selectedTaskId ? withServerFields(current, next) : current,
              )
            })
            .catch(() => {})
        }, delay),
      )
    }

    function advanceSequence(event: TaskEvent): void {
      if (event.seq <= lastAcceptedSequence) return
      acceptedOutOfOrder.add(event.seq)
      while (acceptedOutOfOrder.delete(lastAcceptedSequence + 1)) lastAcceptedSequence++
    }

    function acceptEvents(events: TaskEvent[]): void {
      const matching = events.filter(
        (event) =>
          event.taskId === selectedTaskId &&
          Number.isSafeInteger(event.seq) &&
          (event.seq > 0 || (event.seq === 0 && event.type === 'error')),
      )
      if (matching.length === 0) return
      if (!detailsLoaded) {
        bufferedEvents = mergeEvents(bufferedEvents, matching)
        return
      }
      const ephemeralErrors = matching.filter((event) => event.seq === 0 && event.type === 'error')
      const newlyAccepted = matching
        .filter(
          (event) => event.seq > 0 && event.seq > lastAcceptedSequence && !acceptedOutOfOrder.has(event.seq),
        )
        .sort((first, second) => first.seq - second.seq)
      const additions = [...newlyAccepted, ...ephemeralErrors]
      if (additions.length === 0) return
      for (const event of newlyAccepted) advanceSequence(event)
      const statusEvents = newlyAccepted.filter(
        (event) =>
          (event.type === 'result' || event.type === 'error') &&
          event.seq > taskStatusSequence &&
          event.seq > snapshotSequence,
      )
      if (statusEvents.length) taskStatusSequence = statusEvents.at(-1)?.seq ?? taskStatusSequence
      if (ephemeralErrors.length) ephemeralFailureSeen = true
      setDetails((current) => {
        if (!current || current.task.id !== selectedTaskId) return current
        let task = statusEvents.reduce(taskAfterEvent, current.task)
        if (ephemeralErrors.length) task = { ...task, status: 'failed' }
        return { ...current, task, events: mergeEvents(current.events, additions) }
      })
      if (additions.some((event) => event.type === 'result' || event.type === 'error')) refreshTaskList()
      if (additions.some(changesServerFields)) scheduleExtras()
    }

    function connect(): void {
      if (!active) return
      const nextSocket = new WebSocket(socketUrl(), ['joy', `joy-auth.${apiToken()}`])
      socket = nextSocket
      nextSocket.onopen = () => {
        if (!active) return
        stableConnectionTimer = window.setTimeout(() => {
          reconnectAttempts = 0
        }, 10_000)
      }
      nextSocket.onmessage = (message) => {
        let decoded: Record<string, unknown> | null
        try {
          decoded = record(JSON.parse(String(message.data)))
        } catch {
          return
        }
        if (decoded?.type === 'snapshot') {
          const task = record(decoded.task) as unknown as Task | null
          const sequence = decoded.lastSequence
          if (
            !task ||
            task.id !== selectedTaskId ||
            !Number.isSafeInteger(sequence) ||
            (sequence as number) < 0
          )
            return
          if ((sequence as number) >= snapshotSequence) {
            snapshotTask = task
            snapshotSequence = sequence as number
          }
          if (detailsLoaded && snapshotSequence >= taskStatusSequence) {
            taskStatusSequence = snapshotSequence
            setDetails((current) => {
              if (!current || current.task.id !== selectedTaskId) return current
              if (ephemeralFailureSeen && snapshotTask?.status !== 'failed') return current
              return { ...current, task: snapshotTask as Task }
            })
          }
          return
        }
        if (decoded?.type !== 'event') return
        const event = record(decoded.event) as unknown as TaskEvent | null
        if (!event || typeof event.seq !== 'number') return
        acceptEvents([event])
      }
      nextSocket.onclose = () => {
        if (stableConnectionTimer !== undefined) window.clearTimeout(stableConnectionTimer)
        if (!active) return
        const delay = Math.min(500 * 2 ** reconnectAttempts, 30_000)
        reconnectAttempts = Math.min(reconnectAttempts + 1, 6)
        reconnectTimer = window.setTimeout(connect, delay)
      }
      nextSocket.onerror = () => nextSocket.close()
    }

    connect()
    void request<TaskDetails>(`/api/tasks/${encodeURIComponent(selectedTaskId)}`)
      .then((next) => {
        if (!active) return
        const snapshotLastSequence = next.events.reduce(
          (latest, event) => (event.seq > 0 ? Math.max(latest, event.seq) : latest),
          0,
        )
        const snapshotEvents = mergeEvents(next.events, bufferedEvents)
        const pendingEvents = bufferedEvents
          .filter((event) => event.seq > snapshotLastSequence && event.seq > 0)
          .sort((first, second) => first.seq - second.seq)
        const ephemeralErrors = bufferedEvents.filter((event) => event.seq === 0 && event.type === 'error')
        let task = snapshotTask && snapshotSequence >= snapshotLastSequence ? snapshotTask : next.task
        taskStatusSequence =
          snapshotTask && snapshotSequence >= snapshotLastSequence ? snapshotSequence : snapshotLastSequence
        const pendingStatusEvents = pendingEvents.filter(
          (event) => (event.type === 'result' || event.type === 'error') && event.seq > taskStatusSequence,
        )
        task = pendingStatusEvents.reduce(taskAfterEvent, task)
        taskStatusSequence = Math.max(taskStatusSequence, pendingStatusEvents.at(-1)?.seq ?? -1)
        if (ephemeralErrors.length) {
          ephemeralFailureSeen = true
          task = ephemeralErrors.reduce(taskAfterEvent, task)
        }
        lastAcceptedSequence = snapshotLastSequence
        acceptedOutOfOrder.clear()
        for (const event of pendingEvents) advanceSequence(event)
        bufferedEvents = []
        detailsLoaded = true
        setDetails({ ...next, task, events: snapshotEvents })
        if (pendingStatusEvents.length || ephemeralErrors.length) refreshTaskList()
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : '無法載入任務')
      })
    return () => {
      active = false
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      if (stableConnectionTimer !== undefined) window.clearTimeout(stableConnectionTimer)
      for (const timer of extrasTimers) window.clearTimeout(timer)
      socket?.close()
    }
    // setTasks and setError are stable setters from the parent, so only the task id restarts the stream.
  }, [selectedTaskId])

  return [details, setDetails]
}
