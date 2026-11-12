/**
 * 密钥字段读取。
 *
 * 单独成文件是为了断开 ESM 循环：connectors/ 和 drivers/ 都从这里取密钥，
 * 而 config.js 要 import drivers/index.js（config 再 re-export 这里的函数，
 * 保持旧 import 路径可用）。
 */

import { pickString } from './driver-kit.js'

/**
 * 先看 <field>Env 指向的环境变量，再退回配置里的 <field>。
 * 环境变量名写了但没设值时报错（提示明确，不静默降级）。
 */
export function readSecretValue(conn, field, envField) {
  const envName = pickString(conn?.[envField === undefined ? `${field}Env` : envField])
  if (envName !== undefined) {
    const value = process.env[envName]
    if (value === undefined) {
      throw new Error(`连接 ${conn.name} 需要环境变量 ${envName}，但它没有设置`)
    }
    return value
  }
  return pickString(conn?.[field])
}

/** 兼容旧签名：readSecret(conn, field = 'password', envField = 'passwordEnv')。 */
export function readSecret(conn, field = 'password', envField = 'passwordEnv') {
  return readSecretValue(conn, field, envField)
}
