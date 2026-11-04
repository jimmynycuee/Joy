import { z } from 'zod'

/** Stable Joy port operation names; these are not third-party MCP tool names. */
export const GOOGLE_WORKSPACE_READ_OPERATIONS = [
  'calendar.list_calendars',
  'calendar.free_busy',
  'calendar.list_events',
  'calendar.get_event',
  'gmail.search_messages',
  'gmail.get_message',
  'gmail.search_threads',
  'gmail.get_thread',
] as const

export type GoogleWorkspaceReadOperation = (typeof GOOGLE_WORKSPACE_READ_OPERATIONS)[number]

const pageSize = z.number().int().min(1).max(250)
const mailPageSize = z.number().int().min(1).max(100)
const nonEmpty = z.string().trim().min(1)
const instant = z.string().min(1)

function validateOrderedRange(value: { start: string; end: string }, context: z.RefinementCtx): void {
  const start = Date.parse(value.start)
  const end = Date.parse(value.end)
  if (!Number.isFinite(start))
    context.addIssue({ code: 'custom', path: ['start'], message: 'start must be a valid date-time' })
  if (!Number.isFinite(end))
    context.addIssue({ code: 'custom', path: ['end'], message: 'end must be a valid date-time' })
  if (Number.isFinite(start) && Number.isFinite(end) && start >= end)
    context.addIssue({ code: 'custom', path: ['end'], message: 'end must be after start' })
}

const listCalendarsInputSchema = z.object({
  pageToken: nonEmpty.optional(),
  maxResults: pageSize.optional(),
})
const freeBusyInputSchema = z
  .object({
    calendarIds: z.array(nonEmpty).min(1),
    start: instant,
    end: instant,
  })
  .superRefine(validateOrderedRange)
const listEventsInputSchema = z
  .object({
    calendarId: nonEmpty,
    start: instant,
    end: instant,
    pageToken: nonEmpty.optional(),
    maxResults: pageSize.optional(),
  })
  .superRefine(validateOrderedRange)
const getEventInputSchema = z.object({ calendarId: nonEmpty, eventId: nonEmpty })
const searchMessagesInputSchema = z.object({
  query: nonEmpty,
  pageToken: nonEmpty.optional(),
  maxResults: mailPageSize.optional(),
})
const getMessageInputSchema = z.object({
  messageId: nonEmpty,
  format: z.enum(['full', 'metadata']).optional(),
})
const searchThreadsInputSchema = z.object({
  query: nonEmpty,
  pageToken: nonEmpty.optional(),
  maxResults: mailPageSize.optional(),
})
const getThreadInputSchema = z.object({ threadId: nonEmpty, format: z.enum(['full', 'metadata']).optional() })

const calendarSchema = z.object({
  id: nonEmpty,
  name: z.string(),
  description: z.string().optional(),
  primary: z.boolean().optional(),
  timeZone: z.string().optional(),
})
const busyIntervalSchema = z.object({ start: instant, end: instant })
const eventSchema = z.object({
  id: nonEmpty,
  calendarId: nonEmpty,
  summary: z.string(),
  description: z.string().optional(),
  location: z.string().optional(),
  status: z.string().optional(),
  start: instant,
  end: instant,
  attendees: z
    .array(
      z.object({
        email: z.string(),
        displayName: z.string().optional(),
        responseStatus: z.string().optional(),
      }),
    )
    .optional(),
})
const messageSummarySchema = z.object({
  id: nonEmpty,
  threadId: nonEmpty,
  snippet: z.string().optional(),
})
const messageSchema = z.object({
  id: nonEmpty,
  threadId: nonEmpty,
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  headers: z.record(z.string(), z.string()),
  body: z
    .object({
      text: z.string().optional(),
      html: z.string().optional(),
    })
    .optional(),
})
const threadSummarySchema = z.object({
  id: nonEmpty,
  snippet: z.string().optional(),
  messageCount: z.number().int().nonnegative().optional(),
})

const listCalendarsResponseSchema = z.object({
  calendars: z.array(calendarSchema),
  nextPageToken: z.string().optional(),
})
const freeBusyResponseSchema = z.object({
  calendars: z.record(z.string(), z.object({ busy: z.array(busyIntervalSchema) })),
})
const listEventsResponseSchema = z.object({
  events: z.array(eventSchema),
  nextPageToken: z.string().optional(),
})
const searchMessagesResponseSchema = z.object({
  messages: z.array(messageSummarySchema),
  nextPageToken: z.string().optional(),
})
const searchThreadsResponseSchema = z.object({
  threads: z.array(threadSummarySchema),
  nextPageToken: z.string().optional(),
})
const threadSchema = z.object({ id: nonEmpty, messages: z.array(messageSchema) })

export type ListCalendarsInput = z.infer<typeof listCalendarsInputSchema>
export type FreeBusyInput = z.infer<typeof freeBusyInputSchema>
export type ListEventsInput = z.infer<typeof listEventsInputSchema>
export type GetEventInput = z.infer<typeof getEventInputSchema>
export type SearchMessagesInput = z.infer<typeof searchMessagesInputSchema>
export type GetMessageInput = z.infer<typeof getMessageInputSchema>
export type SearchThreadsInput = z.infer<typeof searchThreadsInputSchema>
export type GetThreadInput = z.infer<typeof getThreadInputSchema>

export type GoogleCalendar = z.infer<typeof calendarSchema>
export type BusyInterval = z.infer<typeof busyIntervalSchema>
export type GoogleCalendarEvent = z.infer<typeof eventSchema>
export type GmailMessageSummary = z.infer<typeof messageSummarySchema>
export type GmailMessage = z.infer<typeof messageSchema>
export type GmailThreadSummary = z.infer<typeof threadSummarySchema>
export type GmailThread = z.infer<typeof threadSchema>

interface InputMap {
  'calendar.list_calendars': ListCalendarsInput
  'calendar.free_busy': FreeBusyInput
  'calendar.list_events': ListEventsInput
  'calendar.get_event': GetEventInput
  'gmail.search_messages': SearchMessagesInput
  'gmail.get_message': GetMessageInput
  'gmail.search_threads': SearchThreadsInput
  'gmail.get_thread': GetThreadInput
}

interface ResponseMap {
  'calendar.list_calendars': z.infer<typeof listCalendarsResponseSchema>
  'calendar.free_busy': z.infer<typeof freeBusyResponseSchema>
  'calendar.list_events': z.infer<typeof listEventsResponseSchema>
  'calendar.get_event': GoogleCalendarEvent
  'gmail.search_messages': z.infer<typeof searchMessagesResponseSchema>
  'gmail.get_message': GmailMessage
  'gmail.search_threads': z.infer<typeof searchThreadsResponseSchema>
  'gmail.get_thread': GmailThread
}

export type GoogleWorkspaceReadRequest = {
  [Operation in GoogleWorkspaceReadOperation]: {
    operation: Operation
    input: InputMap[Operation]
  }
}[GoogleWorkspaceReadOperation]

/** Transport seam for a future, explicitly configured read-only MCP/API connector. */
export interface GoogleWorkspaceReadConnector {
  invoke(request: GoogleWorkspaceReadRequest): Promise<unknown>
}

export interface GoogleWorkspaceReader {
  listCalendars(input?: ListCalendarsInput): Promise<ResponseMap['calendar.list_calendars']>
  freeBusy(input: FreeBusyInput): Promise<ResponseMap['calendar.free_busy']>
  listEvents(input: ListEventsInput): Promise<ResponseMap['calendar.list_events']>
  getEvent(input: GetEventInput): Promise<GoogleCalendarEvent>
  searchMessages(input: SearchMessagesInput): Promise<ResponseMap['gmail.search_messages']>
  getMessage(input: GetMessageInput): Promise<GmailMessage>
  searchThreads(input: SearchThreadsInput): Promise<ResponseMap['gmail.search_threads']>
  getThread(input: GetThreadInput): Promise<GmailThread>
}

const inputSchemas = {
  'calendar.list_calendars': listCalendarsInputSchema,
  'calendar.free_busy': freeBusyInputSchema,
  'calendar.list_events': listEventsInputSchema,
  'calendar.get_event': getEventInputSchema,
  'gmail.search_messages': searchMessagesInputSchema,
  'gmail.get_message': getMessageInputSchema,
  'gmail.search_threads': searchThreadsInputSchema,
  'gmail.get_thread': getThreadInputSchema,
} satisfies { [Operation in GoogleWorkspaceReadOperation]: z.ZodType<InputMap[Operation]> }

const responseSchemas = {
  'calendar.list_calendars': listCalendarsResponseSchema,
  'calendar.free_busy': freeBusyResponseSchema,
  'calendar.list_events': listEventsResponseSchema,
  'calendar.get_event': eventSchema,
  'gmail.search_messages': searchMessagesResponseSchema,
  'gmail.get_message': messageSchema,
  'gmail.search_threads': searchThreadsResponseSchema,
  'gmail.get_thread': threadSchema,
} satisfies { [Operation in GoogleWorkspaceReadOperation]: z.ZodType<ResponseMap[Operation]> }

/** Exposes only read methods and validates both requests and untrusted connector responses. */
export function createGoogleWorkspaceReader(connector: GoogleWorkspaceReadConnector): GoogleWorkspaceReader {
  async function invoke<Operation extends GoogleWorkspaceReadOperation>(
    operation: Operation,
    input: InputMap[Operation],
  ): Promise<ResponseMap[Operation]> {
    const parsedInput = inputSchemas[operation].parse(input) as InputMap[Operation]
    const request = { operation, input: parsedInput } as GoogleWorkspaceReadRequest
    const response = await connector.invoke(request)
    return responseSchemas[operation].parse(response) as ResponseMap[Operation]
  }

  return {
    listCalendars: (input = {}) => invoke('calendar.list_calendars', input),
    freeBusy: (input) => invoke('calendar.free_busy', input),
    listEvents: (input) => invoke('calendar.list_events', input),
    getEvent: (input) => invoke('calendar.get_event', input),
    searchMessages: (input) => invoke('gmail.search_messages', input),
    getMessage: (input) => invoke('gmail.get_message', input),
    searchThreads: (input) => invoke('gmail.search_threads', input),
    getThread: (input) => invoke('gmail.get_thread', input),
  }
}
