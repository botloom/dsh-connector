/** MySQL 驱动：复用 lib/connectors/sql.js（mysql2），默认只读。 */

import { pickNumber, pickString } from '../driver-kit.js'
import {
  databasesAction,
  describeSqlConnection,
  probeSqlConnection,
  queryAction,
  sqlActions,
  unsupportedSqlAction,
} from './sql-common.js'

const LABEL = 'MySQL'

export default {
  kind: 'mysql',
  label: LABEL,
  category: 'database',
  aliases: ['mariadb'],
  defaultPort: 3306,
  fields: [
    { name: 'host', label: '主机', type: 'text', placeholder: '127.0.0.1' },
    { name: 'port', label: '端口', type: 'number', placeholder: '3306' },
    { name: 'database', label: '数据库', type: 'text', hint: '可留空，连上后再选库' },
    { name: 'user', label: '用户名', type: 'text' },
    { name: 'password', label: '密码', type: 'password' },
    { name: 'passwordEnv', label: '密码环境变量', type: 'text' },
    { name: 'allowWrite', label: '允许写', type: 'boolean', hint: '还要在调用时传 write: true' },
    { name: 'allowDdl', label: '允许结构变更（DROP/ALTER）', type: 'boolean', hint: '默认关：DROP/TRUNCATE/ALTER 会被拒绝' },
    { name: 'timeoutMs', label: '超时（毫秒）', type: 'number' },
  ],
  secretFields: ['password'],
  actions: sqlActions,

  validate(conn) {
    return {
      ...conn,
      host: pickString(conn.host) ?? '127.0.0.1',
      port: pickNumber(conn.port) ?? 3306,
      user: pickString(conn.user),
      database: pickString(conn.database),
      allowWrite: conn.allowWrite === true,
    allowDdl: conn.allowDdl === true,
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
    return describeSqlConnection(conn, LABEL)
  },
}
