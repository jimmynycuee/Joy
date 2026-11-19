# CLI versions (T4.6)

Joy reads the Claude Code and Codex CLIs' output, which can change in any release. The versions the contract
fixtures in `tests/fixtures/cli-events/` were recorded with are the **tested range** in
`packages/providers/src/versions.ts` (`TESTED_CLI_VERSIONS`). A test fails if the two disagree.

## What warns

- **On startup** Joy runs `claude --version` and `codex --version`; an untested version is written to the debug log
  (`~/.joy/logs`) and the console.
- **`pnpm joy doctor`** and the setup panel show the CLI as `untested` with the command to re-record.
- **Weekly CI** (`.github/workflows/cli-contract.yml`, also runnable by hand) checks the newest published versions and
  re-runs the provider contract tests. It runs only `--version`: no login and no model calls.

## Re-recording after a CLI update

On a computer where the CLI is logged in (macOS, Linux or WSL), with the cheapest model at low effort:

```bash
node scripts/record-fixtures.mjs claude
```

```bash
node scripts/record-fixtures.mjs codex
```

Then:

1. Run `pnpm test`. Fix the parser in `packages/providers` if a contract test fails.
2. Update `TESTED_CLI_VERSIONS` to the versions in the new `*.meta.json` files (the test tells you the expected value).
3. Open a PR with the new fixtures and the range change.

The repository is public. The recorder replaces temp, repo and home paths, and it strips the recording owner's own
setup out of Claude's `system/init` line (plugins, claude.ai connectors and their tools, skills, agents). Check the
diff for anything personal before you commit. `node scripts/record-fixtures.mjs claude --scrub` re-applies the
stripping to the files already recorded, without calling a model.

Recording spends a little of the subscription quota; never record in CI.
