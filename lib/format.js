/** 给模型看的文本排版：单行化、截断、表格。 */

export function oneLine(text, max = 400) {
  const flat = `${text}`.replace(/\r\n/g, '\n').replace(/\n/g, ' ⏎ ').replace(/\t/g, ' ')
  return truncate(flat, max)
}

export function truncate(text, max) {
  const value = `${text}`
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

export function formatValue(value) {
  if (value === null || value === undefined) return 'NULL'
  if (value instanceof Uint8Array) {
    const hex = Buffer.from(value).toString('hex')
    return hex.length > 64 ? `0x${hex.slice(0, 64)}…(${value.length}B)` : `0x${hex}`
  }
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString()
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/** 行数组 + 列名 → 竖线表格；不补齐宽度，避免宽字符错位。 */
export function formatTable(columns, rows, { cellMax = 200, maxRows = 50 } = {}) {
  const visible = rows.slice(0, maxRows)
  const renderCell = (value) => oneLine(formatValue(value), cellMax)
  const head = columns.map(renderCell).join(' | ')
  const separator = columns.map(() => '---').join(' | ')
  const body = visible.map((row) => row.map(renderCell).join(' | ')).join('\n')
  return [head, separator, body].filter((part) => part !== '').join('\n')
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'n/a'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
