/** SQLite 驱动：复用 lib/connectors/sql.js（Node 内置 node:sqlite），默认只读。 */

import path from 'node:path'
import { pickString } from '../driver-kit.js'
import {
  databasesAction,
  probeSqlConnection,
  queryAction,
  sqlActions,
  unsupportedSqlAction,
} from './sql-common.js'

const LABEL = 'SQLite'

export default {
  kind: 'sqlite',
  label: LABEL,
  category: 'database',
  aliases: ['sqlite3'],
  defaultPort: undefined,
  fields: [
    { name: 'file', label: '数据库文件', type: 'text', required: true, placeholder: 'C:/work/app/data.db' },
    { name: 'allowWrite', label: '允许写', type: 'boolean', hint: '还要在调用时传 write: true' },
    { name: 'timeoutMs', label: '超时（毫秒）', type: 'number' },
  ],
  secretFields: ['password'],
  actions: sqlActions,

  validate(conn) {
    const file = pickString(conn.file)
    if (file === undefined) throw new Error(`连接 ${conn.name} 缺少 file`)
    return {
      ...conn,
      file: path.resolve(file),
      allowWrite: conn.allowWrite === true,
    }
  },

  async probe(conn, opts) {
    return probeSqlConnection(conn, opts)
  },

  async call(conn, action, args, opts) {
    if (action === 'query') return queryAction(conn, args, opts)
    if (action === 'databases') return databasesAction(conn, args, opts)
    throw unsupportedSqlAction(conn, LABEL, action)
  },

  async callArgs(conn, args, opts) {
    return queryAction(conn, args, opts)
  },

  describe(conn) {
    return `${LABEL} ${conn.file}${conn.allowWrite ? ' 可写' : ' 只读'}`
  },
}
