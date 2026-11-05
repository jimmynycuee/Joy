/** Parses a Server-Sent Events body into `{ event, data }` records. Only `data:` lines carry JSON here. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string | undefined; data: string }> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
    let sep: number
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      const parsed = parseBlock(block)
      if (parsed) yield parsed
    }
  }
  const tail = parseBlock(buffer + decoder.decode())
  if (tail) yield tail
}

function parseBlock(block: string): { event: string | undefined; data: string } | undefined {
  let event: string | undefined
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  return data.length ? { event, data: data.join('\n') } : undefined
}
