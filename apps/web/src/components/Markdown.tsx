import type { ReactNode } from 'react'
import { parseMarkdown } from '../markdown.js'
import type { Block, Inline } from '../markdown.js'

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.t) {
      case 'text':
        return node.v
      case 'br':
        return <br key={index} />
      case 'code':
        return <code key={index}>{node.v}</code>
      case 'strong':
        return <strong key={index}>{renderInline(node.c)}</strong>
      case 'em':
        return <em key={index}>{renderInline(node.c)}</em>
      case 'link':
        return (
          <a key={index} href={node.href} target="_blank" rel="noreferrer noopener">
            {renderInline(node.c)}
          </a>
        )
    }
  })
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.t) {
      case 'p':
        return <p key={index}>{renderInline(block.c)}</p>
      case 'h': {
        const level = Math.min(Math.max(block.level + 2, 3), 6)
        const Tag = `h${level}` as 'h3' | 'h4' | 'h5' | 'h6'
        return <Tag key={index}>{renderInline(block.c)}</Tag>
      }
      case 'code':
        return (
          <pre key={index} className="md-code" data-lang={block.lang || undefined}>
            <code>{block.v}</code>
          </pre>
        )
      case 'quote':
        return <blockquote key={index}>{renderBlocks(block.c)}</blockquote>
      case 'hr':
        return <hr key={index} />
      case 'list': {
        const items = block.items.map((item, itemIndex) => (
          <li key={itemIndex}>
            {renderInline(item.c)}
            {renderBlocks(item.children)}
          </li>
        ))
        return block.ordered ? (
          <ol key={index} start={block.start}>
            {items}
          </ol>
        ) : (
          <ul key={index}>{items}</ul>
        )
      }
      case 'table':
        return (
          <div key={index} className="md-table-wrap">
            <table>
              <thead>
                <tr>
                  {block.head.map((cell, cellIndex) => (
                    <th key={cellIndex}>{renderInline(cell)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{renderInline(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
    }
  })
}

/** Agent and assistant text as safe prose: parsed to a tree, so raw HTML is shown as text and never injected. */
export function Markdown({ text }: { text: string }) {
  return <div className="prose">{renderBlocks(parseMarkdown(text))}</div>
}
