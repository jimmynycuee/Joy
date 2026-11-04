import { describe, expect, it } from 'vitest'
import {
  createGoogleWorkspaceReader,
  GOOGLE_WORKSPACE_READ_OPERATIONS,
  type GoogleWorkspaceReadConnector,
  type GoogleWorkspaceReadRequest,
} from './index.js'

class FakeMcpConnector implements GoogleWorkspaceReadConnector {
  readonly requests: GoogleWorkspaceReadRequest[] = []
  readonly responses: Partial<Record<GoogleWorkspaceReadRequest['operation'], unknown>> = {}

  async invoke(request: GoogleWorkspaceReadRequest): Promise<unknown> {
    this.requests.push(request)
    return this.responses[request.operation]
  }
}

const message = {
  id: 'message-1',
  threadId: 'thread-1',
  snippet: 'Synthetic message content',
  headers: { from: 'sender@example.test', subject: 'Synthetic subject' },
  body: { text: 'Synthetic fixture only' },
}

describe('Google Workspace read adapter boundary', () => {
  it('routes the complete read-only surface through a fake connector', async () => {
    const connector = new FakeMcpConnector()
    connector.responses['calendar.list_calendars'] = {
      calendars: [{ id: 'primary', name: 'Primary', primary: true }],
    }
    connector.responses['calendar.free_busy'] = {
      calendars: { primary: { busy: [{ start: '2026-06-01T10:00:00Z', end: '2026-06-01T11:00:00Z' }] } },
    }
    connector.responses['calendar.list_events'] = {
      events: [
        {
          id: 'event-1',
          calendarId: 'primary',
          summary: 'Synthetic event',
          start: '2026-06-01T10:00:00Z',
          end: '2026-06-01T11:00:00Z',
        },
      ],
      nextPageToken: 'calendar-next',
    }
    connector.responses['calendar.get_event'] = {
      id: 'event-1',
      calendarId: 'primary',
      summary: 'Synthetic event',
      start: '2026-06-01T10:00:00Z',
      end: '2026-06-01T11:00:00Z',
    }
    connector.responses['gmail.search_messages'] = {
      messages: [{ id: message.id, threadId: message.threadId }],
    }
    connector.responses['gmail.get_message'] = message
    connector.responses['gmail.search_threads'] = {
      threads: [{ id: 'thread-1', messageCount: 1 }],
      nextPageToken: 'mail-next',
    }
    connector.responses['gmail.get_thread'] = { id: 'thread-1', messages: [message] }
    const reader = createGoogleWorkspaceReader(connector)

    await expect(reader.listCalendars()).resolves.toMatchObject({ calendars: [{ id: 'primary' }] })
    await reader.freeBusy({
      calendarIds: ['primary'],
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-02T00:00:00Z',
    })
    await reader.listEvents({
      calendarId: 'primary',
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-02T00:00:00Z',
    })
    await reader.getEvent({ calendarId: 'primary', eventId: 'event-1' })
    await reader.searchMessages({ query: 'from:sender@example.test' })
    await reader.getMessage({ messageId: 'message-1' })
    await reader.searchThreads({ query: 'subject:synthetic' })
    await reader.getThread({ threadId: 'thread-1' })

    expect(connector.requests.map(({ operation }) => operation)).toEqual(GOOGLE_WORKSPACE_READ_OPERATIONS)
    expect(connector.requests[1]).toEqual({
      operation: 'calendar.free_busy',
      input: {
        calendarIds: ['primary'],
        start: '2026-06-01T00:00:00Z',
        end: '2026-06-02T00:00:00Z',
      },
    })
  })

  it('rejects invalid ranges and oversized searches before invoking the connector', async () => {
    const connector = new FakeMcpConnector()
    const reader = createGoogleWorkspaceReader(connector)

    await expect(
      reader.freeBusy({
        calendarIds: ['primary'],
        start: '2026-06-02T00:00:00Z',
        end: '2026-06-01T00:00:00Z',
      }),
    ).rejects.toThrow('end must be after start')
    await expect(reader.searchMessages({ query: 'hello', maxResults: 101 })).rejects.toThrow()
    expect(connector.requests).toHaveLength(0)
  })

  it('validates synthetic connector responses before returning them', async () => {
    const connector = new FakeMcpConnector()
    connector.responses['gmail.get_message'] = { id: 'message-1', body: 'not the normalized shape' }
    const reader = createGoogleWorkspaceReader(connector)

    await expect(reader.getMessage({ messageId: 'message-1' })).rejects.toThrow()
    expect(connector.requests).toHaveLength(1)
    expect(connector.requests[0]?.operation).toBe('gmail.get_message')
  })

  it('declares no write operation in its exported operation surface', () => {
    expect(GOOGLE_WORKSPACE_READ_OPERATIONS).toEqual([
      'calendar.list_calendars',
      'calendar.free_busy',
      'calendar.list_events',
      'calendar.get_event',
      'gmail.search_messages',
      'gmail.get_message',
      'gmail.search_threads',
      'gmail.get_thread',
    ])
    expect(
      GOOGLE_WORKSPACE_READ_OPERATIONS.some((operation) =>
        /send|draft|create|update|delete|invite/.test(operation),
      ),
    ).toBe(false)
  })
})
