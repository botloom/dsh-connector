import { getDriver } from '../drivers/index.js'

/** 按 kind 派发连通性探测（具体实现由驱动提供）。 */
export async function probeConnection(conn, timeoutMs) {
  const driver = getDriver(conn.kind)
  return driver.probe(conn, { timeoutMs: conn.timeoutMs ?? timeoutMs })
}
