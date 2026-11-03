import { expect, test } from '@playwright/test'

test('compete compares fake candidates and persists the selected winner', async ({ page, request }) => {
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
  const winner = result?.candidates?.find((candidate) => candidate.status === 'succeeded')
  expect(winner).toBeDefined()

  await page.getByRole('button', { name: 'Select winner' }).first().click()
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
