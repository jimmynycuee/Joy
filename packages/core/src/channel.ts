export type ChannelId = 'web' | 'telegram' | 'line'

export interface MessageButton {
  id: string
  label: string
}

export interface OutboundMessage {
  text: string
  buttons?: MessageButton[]
  /** Correlates button presses with what they answer (e.g. an approval id). */
  correlationId?: string
}

export interface InboundMessage {
  channel: ChannelId
  /** Channel-specific sender id; channels must reject anyone but the owner before this is emitted. */
  senderId: string
  text?: string
  buttonId?: string
  correlationId?: string
  receivedAt: string
}

export interface Channel {
  readonly id: ChannelId
  send(msg: OutboundMessage): Promise<void>
  onMessage(handler: (msg: InboundMessage) => Promise<void>): () => void
}
