export function maxEventSequence(events: readonly { seq: number }[]): number {
  let latest = 0
  for (const event of events) {
    if (event.seq > latest) latest = event.seq
  }
  return latest
}
