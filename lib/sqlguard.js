/**
 * SQL 语句切分与只读判定。
 *
 * 目的只有一个：默认挡住写语句，避免「帮我查个问题」顺手改库。
 * 规则宁可保守——判不出来就算写。
 */

const READ_ONLY_HEADS = new Set([
  'SELECT',
  'SHOW',
  'DESC',
  'DESCRIBE',
  'VALUES',
  'TABLE',
])

const WRITE_WORDS =
  /\b(insert|update|delete|merge|drop|alter|truncate|create|grant|revoke|copy|call|do|vacuum|reindex|replace|load|import|lock)\b/i

/** 按分号切语句，忽略引号、反引号、注释、$$ dollar-quote 里的分号。 */
export function splitStatements(sql) {
  const text = `${sql}`
  const statements = []
  let current = ''
  let index = 0
  let quote

  while (index < text.length) {
    const char = text[index]

    if (quote !== undefined) {
      current += char
      if (char === '\\' && quote !== '`') {
        current += text[index + 1] ?? ''
        index += 2
        continue
      }
      if (char === quote) {
        if (text[index + 1] === quote) {
          current += text[index + 1]
          index += 2
          continue
        }
        quote = undefined
      }
      index += 1
      continue
    }

    if (char === '-' && text[index + 1] === '-') {
      const newline = text.indexOf('\n', index)
      if (newline === -1) break
      current += '\n'
      index = newline + 1
      continue
    }

    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 2
      current += ' '
      continue
    }

    if (char === '$') {
      const tagged = /^\$[A-Za-z_0-9]*\$/.exec(text.slice(index))
      if (tagged !== null) {
        const tag = tagged[0]
        const end = text.indexOf(tag, index + tag.length)
        if (end === -1) {
          current += text.slice(index)
          break
        }
        current += text.slice(index, end + tag.length)
        index = end + tag.length
        continue
      }
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char
      current += char
      index += 1
      continue
    }

    if (char === ';') {
      statements.push(current)
      current = ''
      index += 1
      continue
    }

    current += char
    index += 1
  }

  statements.push(current)
  return statements.map((statement) => statement.trim()).filter((statement) => statement !== '')
}

function isReadOnlyStatement(statement) {
  const head = (/^[a-z]+/i.exec(statement)?.[0] ?? '').toUpperCase()

  if (head === 'EXPLAIN') {
    // EXPLAIN ANALYZE UPDATE ... 会真的写库，剥掉 EXPLAIN 前缀再判。
    const rest = statement.replace(/^explain\s*(\([^)]*\))?\s*/i, '')
    return isReadOnlyStatement(rest)
  }
  if (head === 'PRAGMA') {
    return !/[=]/.test(statement)
  }
  if (head === 'WITH') {
    return !WRITE_WORDS.test(statement)
  }
  return READ_ONLY_HEADS.has(head)
}

/**
 * 返回 { sql, head, readOnly }；多条语句、空语句直接抛错。
 */
export function classifySql(sql) {
  const statements = splitStatements(sql)
  if (statements.length === 0) throw new Error('SQL 是空的')
  if (statements.length > 1) {
    throw new Error(`一次只能提交一条语句，检测到 ${statements.length} 条`)
  }
  const statement = statements[0]
  const head = (/^[a-z]+/i.exec(statement)?.[0] ?? '').toUpperCase() || '?'
  return { sql: statement, head, readOnly: isReadOnlyStatement(statement) }
}

/**
 * 写语句的第二道门：即使连接允许写入，也挡住最容易「删库」的形态。
 *
 * - DROP / TRUNCATE / ALTER：连接要显式 allowDdl: true，否则拒绝
 * - UPDATE / DELETE 不带 WHERE：拒绝（防止误改/误删全表）
 *
 * 纯函数，抛错表示拒绝。
 */
export function assertSafeWrite(statement, options = {}) {
  const text = `${statement}`.trim()
  const head = (/^[a-z]+/i.exec(text)?.[0] ?? '').toUpperCase()
  const allowDdl = options.allowDdl === true
  const name = typeof options.name === 'string' && options.name !== '' ? `连接 ${options.name} ` : ''

  if ((head === 'DROP' || head === 'TRUNCATE' || head === 'ALTER') && !allowDdl) {
    throw new Error(
      `拒绝执行 ${head}（结构变更）：${name}没有开启 allowDdl。确需执行时把该连接的配置加上 allowDdl: true。`,
    )
  }
  if ((head === 'DELETE' || head === 'UPDATE') && !/\bwhere\b/i.test(text)) {
    throw new Error(`拒绝执行不带 WHERE 的 ${head}：会命中整张表。确需如此请显式写 WHERE 1=1。`)
  }
}
