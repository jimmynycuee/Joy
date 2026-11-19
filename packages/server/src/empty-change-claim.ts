// Small models sometimes answer "已修正 math.js" without editing anything. This is the conservative check for that:
// nothing changed in the worktree, the run reported no file_change event, and the final message talks as if it did.
const CLAIM_WORDS = /修正|修改|已改|改好|更新|新增|加入|fixed|changed|updated|added|modified|edited|created/i
const FILE_PATH =
  /(?:^|[\s`'"(])[\w./-]+\.(?:[cm]?[jt]sx?|json|md|py|rs|go|css|html|ya?ml|toml|java|kt|swift|rb|sh)\b/i

export function claimsChangesWithoutAny(input: {
  finalMessage: string | undefined
  fileChangeEvents: number
  diffFiles: number
}): boolean {
  if (input.diffFiles > 0 || input.fileChangeEvents > 0) return false
  const text = input.finalMessage ?? ''
  return CLAIM_WORDS.test(text) || FILE_PATH.test(text)
}
