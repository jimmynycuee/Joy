export { migrate, openDatabase, schemaVersion } from './database.js'
export type { Database, OpenOptions } from './database.js'
export { LATEST_VERSION, MIGRATIONS } from './migrations.js'
export type { Migration } from './migrations.js'
export {
  addUsage,
  appendTaskEvent,
  appendTaskFailureEvent,
  createAttempt,
  createRepo,
  createReview,
  createTask,
  getAttempt,
  getRepo,
  getTask,
  interruptRunningWork,
  latestAttempt,
  listAttempts,
  listReviews,
  listRepos,
  listTaskEvents,
  listTasks,
  listUsage,
  setTaskStatus,
  updateAttempt,
  updateRepoAllowedProviders,
  updateRepoGithubRemote,
} from './repositories.js'
export type {
  AttemptRecord,
  AttemptUpdate,
  NewAttempt,
  NewRepo,
  NewReview,
  NewTask,
  RepoRecord,
  ReviewRecord,
  StoredTask,
  TaskEventRecord,
  UsageIncrement,
  UsageRecord,
} from './repositories.js'
export {
  approveTimedOutApproval,
  createApproval,
  decideApproval,
  expirePendingApprovals,
  getApproval,
  listApprovals,
} from './approvals.js'
export type { ApprovalRecord, ApprovalStatus, NewApproval } from './approvals.js'
export {
  appendMessage,
  createConversation,
  getConversation,
  listConversations,
  listMessages,
  setConversationTitle,
  updateConversationSession,
} from './conversations.js'
export type { ConversationRecord, MessageRecord, MessageRole } from './conversations.js'
