import { describe, expect, it } from 'vitest'
import { shortTitle, taskTitle } from './labels.js'

describe('taskTitle', () => {
  it('prefers what the owner typed', () => {
    expect(taskTitle('  My title ', 'Something else entirely.')).toBe('My title')
  })

  it('takes the prompt first sentence, without the full stop and extra spaces', () => {
    expect(taskTitle('', '修好登入頁。按 Enter 沒有反應，也要補測試。')).toBe('修好登入頁')
    expect(taskTitle('', 'Fix   the login   page. Pressing Enter does nothing.')).toBe('Fix the login page')
    expect(taskTitle('', 'Why does Enter do nothing? Please look.')).toBe('Why does Enter do nothing?')
  })

  it('does not cut at a dot inside a version or file name', () => {
    expect(taskTitle('', 'Bump to v1.2.3 and update a.ts today')).toBe('Bump to v1.2.3 and update a.ts today')
  })

  it('uses only the first line, and still caps a sentence that never ends', () => {
    expect(taskTitle('', '修一個 bug：\n登入頁沒反應')).toBe('修一個 bug：')
    expect(taskTitle('', 'a'.repeat(120))).toBe(`${'a'.repeat(80)}…`)
    expect(taskTitle('', '   ')).toBe('')
  })
})

describe('shortTitle', () => {
  it('leaves a title that fits as it is', () => {
    expect(shortTitle('Fix the login page')).toBe('Fix the login page')
    expect(shortTitle('修好登入頁')).toBe('修好登入頁')
  })

  it('cuts at 24 full-width characters', () => {
    const wide = '一二三四五六七八九十'.repeat(3)
    expect(shortTitle(wide)).toBe(`${wide.slice(0, 24)}…`)
    expect(shortTitle(wide.slice(0, 24))).toBe(wide.slice(0, 24))
  })

  it('cuts at 48 half-width characters', () => {
    const narrow = 'abcdefghij'.repeat(6)
    expect(shortTitle(narrow)).toBe(`${narrow.slice(0, 48)}…`)
    expect(shortTitle(narrow.slice(0, 48))).toBe(narrow.slice(0, 48))
  })

  it('counts a mix by width and never splits a character', () => {
    // 20 full-width (40 columns) then 8 more half-width fits exactly; one more does not.
    const base = '字'.repeat(20)
    expect(shortTitle(`${base}${'x'.repeat(8)}`)).toBe(`${base}${'x'.repeat(8)}`)
    expect(shortTitle(`${base}${'x'.repeat(9)}`)).toBe(`${base}${'x'.repeat(8)}…`)
    expect(shortTitle('😀'.repeat(30))).toBe(`${'😀'.repeat(24)}…`)
  })

  it('makes a whole pasted prompt one line', () => {
    expect(shortTitle('Fix the login\n\n  page   please')).toBe('Fix the login page please')
    expect(shortTitle('第一行\n第二行')).toBe('第一行 第二行')
  })
})
