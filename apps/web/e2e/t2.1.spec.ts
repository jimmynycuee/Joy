import { expect, test } from '@playwright/test'

test('compete synthesizes candidate strengths and persists the selected winner', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()

  if (await page.getByRole('button', { name: 'Manage repositories' }).isVisible()) {
    await page.getByRole('button', { name: 'Manage repositories' }).click()
  } else {
    await page.getByRole('button', { name: 'Add repository' }).click()
  }
  const repoDialog = page.getByRole('dialog', { name: 'Add repository' })
  await repoDialog.getByLabel('Repository path').fill('/tmp/joy-t2.1-compete-project')
  await repoDialog.getByLabel('Default branch').fill('main')
  await repoDialog.getByRole('button', { name: 'Add repository' }).click()

  await page.getByRole('button', { name: 'New task' }).click()
  const taskDialog = page.getByRole('dialog', { name: 'Create a task' })
  await taskDialog.getByLabel('Task repository').selectOption({ label: '/tmp/joy-t2.1-compete-project' })
  await taskDialog.getByLabel('Task title').fill('Compare fake implementations')
  await taskDialog
    .getByLabel('Task instructions')
    .fill('Make a small greeting change and compare the implementations.')
  await taskDialog.getByLabel('Workflow').selectOption('compete')
  await taskDialog.getByLabel('Implementer provider').selectOption('openai-api')
  await taskDialog.getByLabel('Implementer model').fill('fake-candidate-one')
  await taskDialog.getByLabel('Reviewer provider').selectOption('claude-cli')
  await taskDialog.getByLabel('Reviewer model').fill('fake-candidate-two')
  await taskDialog.getByRole('button', { name: 'Start task' }).click()

  await expect(page.getByRole('heading', { name: 'Compare fake implementations' })).toBeVisible()
  await expect(page.getByTestId('candidate-diff')).toHaveCount(2)
  await expect(page.getByTestId('compete-judge-summary')).toHaveText(
    'Fake judge prefers the first candidate.',
  )
  await expect(page.getByTestId('compete-judge-rationale')).toContainText(
    'has the clearest implementation in this test',
  )
  await expect(page.locator('.large-status')).toHaveText('review ready')
  const patches = await page.getByTestId('candidate-diff').allTextContents()
  expect(patches[0]).toContain('hello from fake')
  expect(patches[1]).toContain('hello from fake')
  expect(patches[0]).not.toBe(patches[1])

  await page.getByTestId('synthesize-strengths').click()
  await expect(page.getByTestId('synthesis-success')).toBeVisible()
  await expect(page.getByText('SYNTHESIZED CANDIDATE', { exact: true })).toBeVisible()
  await expect(page.getByTestId('candidate-diff')).toHaveCount(3)
  if (process.env.JOY_CAPTURE_T2_1 === '1') {
    await page.screenshot({ path: 'test-results/t2.1-synthesis.png' })
  }

  const tasksResponse = await request.get('/api/tasks')
  const tasks = (await tasksResponse.json()) as { tasks: Array<{ id: string; title: string }> }
  const task = tasks.tasks.find((item) => item.title === 'Compare fake implementations')
  expect(task).toBeDefined()
  const beforeResponse = await request.get(`/api/tasks/${task?.id}`)
  const before = (await beforeResponse.json()) as {
    events: Array<{ type: string; payload: unknown }>
  }
  const result = before.events
    .map((event) => event.payload as { candidates?: Array<{ attemptId: string; status: string }> })
    .find((payload) => Array.isArray(payload.candidates))
  const winner = before.events
    .filter((event) => event.type === 'attempt')
    .map((event) => event.payload as { attemptId?: string; synthesized?: boolean })
    .find((candidate) => candidate.synthesized)
  expect(winner).toBeDefined()
  expect(result?.candidates?.filter((candidate) => candidate.status === 'succeeded')).toHaveLength(2)

  await page
    .locator('.candidate-card')
    .filter({ hasText: 'SYNTHESIZED CANDIDATE' })
    .getByRole('button', { name: 'Select winner' })
    .click()
  await expect(page.getByTestId('selected-winner')).toHaveText('Selected winner')
  await expect(page.locator('.large-status')).toHaveText('done')

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Compare fake implementations' })).toBeVisible()
  await expect(page.getByTestId('selected-winner')).toHaveText('Selected winner')
  const afterResponse = await request.get(`/api/tasks/${task?.id}`)
  const after = (await afterResponse.json()) as {
    task: { status: string }
    events: Array<{ type: string; payload: unknown }>
  }
  expect(after.task.status).toBe('done')
  const selection = after.events.find((event) => event.type === 'winner_selected')
  expect(selection?.payload).toMatchObject({ attemptId: winner?.attemptId })
})

test('resume compares only candidates from the latest compete run', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()

  if (await page.getByRole('button', { name: 'Manage repositories' }).isVisible()) {
    await page.getByRole('button', { name: 'Manage repositories' }).click()
  } else {
    await page.getByRole('button', { name: 'Add repository' }).click()
  }
  const repoDialog = page.getByRole('dialog', { name: 'Add repository' })
  await repoDialog.getByLabel('Repository path').fill('/tmp/joy-t2.1-resume-project')
  await repoDialog.getByLabel('Default branch').fill('main')
  await repoDialog.getByRole('button', { name: 'Add repository' }).click()

  await page.getByRole('button', { name: 'New task' }).click()
  const taskDialog = page.getByRole('dialog', { name: 'Create a task' })
  await taskDialog.getByLabel('Task repository').selectOption({ label: '/tmp/joy-t2.1-resume-project' })
  await taskDialog.getByLabel('Task title').fill('Resume latest compete candidates')
  await taskDialog
    .getByLabel('Task instructions')
    .fill('pause-one-candidate-until-cancel; compare the fake candidates.')
  await taskDialog.getByLabel('Workflow').selectOption('compete')
  await taskDialog.getByLabel('Implementer provider').selectOption('claude-cli')
  await taskDialog.getByLabel('Implementer model').fill('fake-implementer')
  await taskDialog.getByLabel('Reviewer provider').selectOption('codex-cli')
  await taskDialog.getByLabel('Reviewer model').fill('fake-reviewer')
  await taskDialog.getByRole('button', { name: 'Start task' }).click()

  const tasksResponse = await request.get('/api/tasks')
  const tasks = (await tasksResponse.json()) as { tasks: Array<{ id: string; title: string }> }
  const task = tasks.tasks.find((item) => item.title === 'Resume latest compete candidates')
  expect(task).toBeDefined()
  const readDetails = async () => {
    const response = await request.get(`/api/tasks/${task?.id}`)
    return (await response.json()) as {
      task: { status: string }
      attempts: Array<{ status: string }>
    }
  }

  await expect
    .poll(async () => (await readDetails()).attempts.filter((attempt) => attempt.status === 'succeeded'))
    .toHaveLength(1)
  const cancelled = await request.post(`/api/tasks/${task?.id}/cancel`)
  expect(cancelled.status()).toBe(200)
  await expect.poll(async () => (await readDetails()).task.status).toBe('cancelled')
  await expect(page.getByTestId('candidate-diff')).toHaveCount(1)
  const previousPatch = await page.getByTestId('candidate-diff').textContent()
  expect(previousPatch).not.toBeNull()

  const resumed = await request.post(`/api/tasks/${task?.id}/resume`)
  expect(resumed.status()).toBe(202)
  await expect.poll(async () => (await readDetails()).task.status).toBe('review_ready')
  await expect(page.locator('.large-status')).toHaveText('review ready')
  await expect(page.getByTestId('candidate-diff')).toHaveCount(2)
  const currentPatches = await page.getByTestId('candidate-diff').allTextContents()
  expect(currentPatches).not.toContain(previousPatch)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Resume latest compete candidates' })).toBeVisible()
  await expect(page.getByTestId('candidate-diff')).toHaveCount(2)
  if (process.env.JOY_CAPTURE_T2_1 === '1') {
    await page.screenshot({ path: 'test-results/t2.1-resume.png' })
  }
})

test('judge failure remains visible while successful candidates can be reviewed', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()

  if (await page.getByRole('button', { name: 'Manage repositories' }).isVisible()) {
    await page.getByRole('button', { name: 'Manage repositories' }).click()
  } else {
    await page.getByRole('button', { name: 'Add repository' }).click()
  }
  const repoDialog = page.getByRole('dialog', { name: 'Add repository' })
  await repoDialog.getByLabel('Repository path').fill('/tmp/joy-t2.1-judge-failure-project')
  await repoDialog.getByLabel('Default branch').fill('main')
  await repoDialog.getByRole('button', { name: 'Add repository' }).click()

  await page.getByRole('button', { name: 'New task' }).click()
  const taskDialog = page.getByRole('dialog', { name: 'Create a task' })
  await taskDialog
    .getByLabel('Task repository')
    .selectOption({ label: '/tmp/joy-t2.1-judge-failure-project' })
  await taskDialog.getByLabel('Task title').fill('Judge failure remains visible')
  await taskDialog.getByLabel('Task instructions').fill('fail-fake-judge; compare the fake candidates.')
  await taskDialog.getByLabel('Workflow').selectOption('compete')
  await taskDialog.getByLabel('Implementer provider').selectOption('claude-cli')
  await taskDialog.getByLabel('Implementer model').fill('fake-implementer')
  await taskDialog.getByLabel('Reviewer provider').selectOption('codex-cli')
  await taskDialog.getByLabel('Reviewer model').fill('fake-reviewer')
  await taskDialog.getByRole('button', { name: 'Start task' }).click()

  await expect(page.locator('.large-status')).toHaveText('review ready')
  await expect(page.getByTestId('candidate-diff')).toHaveCount(2)
  await expect(page.getByTestId('compete-judge-error')).toContainText(
    'The judge did not return a valid candidate selection',
  )

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Judge failure remains visible' })).toBeVisible()
  await expect(page.getByTestId('compete-judge-error')).toContainText(
    'The judge did not return a valid candidate selection',
  )
  await expect(page.getByTestId('candidate-diff')).toHaveCount(2)
  if (process.env.JOY_CAPTURE_T2_1 === '1') {
    await page.screenshot({ path: 'test-results/t2.1-judge-failure.png' })
  }
})
