export { migrate, openDatabase, schemaVersion } from './database.js'
export type { Database, OpenOptions } from './database.js'
export { LATEST_VERSION, MIGRATIONS } from './migrations.js'
export type { Migration } from './migrations.js'
export {
  addUsage,
  appendTaskEvent,
  appendTaskFailureEvent,
  appendTaskLevelEvent,
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
  resetSessionsUsingMemory,
  searchHistory,
  setConversationSummary,
  setConversationTitle,
  updateConversationSession,
} from './conversations.js'
export type { ConversationRecord, HistoryHit, MessageRecord, MessageRole } from './conversations.js'
export {
  createMemory,
  deleteMemory,
  getMemory,
  listActiveMemories,
  listAllMemories,
  markMemoriesUsed,
  searchMemories,
  supersedeMemory,
  updateMemoryContent,
} from './memories.js'
export type { MemoryRecord, MemoryScope, MemorySource, NewMemory } from './memories.js'
export { createProjectNote, decideProjectNote, getProjectNote, listProjectNotes } from './project-notes.js'
export type { ProjectNoteRecord, ProjectNoteStatus } from './project-notes.js'
export {
  advanceSchedule,
  createReminder,
  createSchedule,
  deleteSchedule,
  dueReminders,
  dueSchedules,
  finishReminder,
  getReminder,
  getSchedule,
  listReminders,
  listSchedules,
  setScheduleEnabled,
} from './schedules.js'
export type { ReminderRecord, ReminderStatus, ScheduleAction, ScheduleRecord } from './schedules.js'
export { modelStats } from './stats.js'
export type { ImplementerStats, ModelStats, ReviewerStats, StatsFilter } from './stats.js'
