export { dependencyInstall, installDependencies } from './dependencies.js'
export type {
  DependencyInstall,
  InstallDependenciesOptions,
  InstallDependenciesResult,
  InstallManager,
  PackageManager,
} from './dependencies.js'
export { GitError, KeyedMutex, git, listProjectFiles } from './git.js'
export { runCommand } from './run.js'
export type { RunCommandInput, RunCommandResult } from './run.js'
export {
  CHECKPOINT_REF_PREFIX,
  CheckpointCommitsError,
  CheckpointRestoreIncompleteError,
  checkpointRef,
  UnpushedCommitsError,
  WorktreeExecutor,
  assertSafeId,
  parseNameStatus,
  parseNumstat,
} from './worktree.js'
export type {
  RunInWorktreeInput,
  WorktreeCleanupOptions,
  WorktreeExecutorOptions,
  WorktreeInfo,
} from './worktree.js'
export { CONTAINER_HOME, containerRunCommand, gitCommonDir, stopContainer } from './docker.js'
export type { ContainerMount, ContainerNetwork, ContainerRunInput } from './docker.js'
