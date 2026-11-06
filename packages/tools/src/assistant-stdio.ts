import { createHttpAssistantBridge, startAssistantStdio } from './assistant.js'

const endpoint = process.env.JOY_ASSISTANT_ENDPOINT
const token = process.env.JOY_ASSISTANT_TOKEN
if (!endpoint || !token) throw new Error('The Joy assistant bridge requires an endpoint and token')

await startAssistantStdio(createHttpAssistantBridge(endpoint, token))
