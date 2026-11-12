/** TCP：只做端口可达性与可选的首包探测，用于确认中间件端口是否活着。 */

import net from 'node:net'

function connect(conn, timeoutMs) {
  return new Promise((resolve, reject) => {
    const host = conn.host
    const port = conn.port
    const startedAt = Date.now()
    const socket = net.connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`连接 ${host}:${port} 超时（${timeoutMs}ms）`))
    }, timeoutMs)

    socket.once('connect', () => {
      clearTimeout(timer)
      resolve({ socket, elapsedMs: Date.now() - startedAt })
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(new Error(`连接 ${host}:${port} 失败：${error.message}`))
    })
  })
}

/** 探测端口；conn.send 会先发一段文本，再尽量读回 banner（最多 1KB）。 */
export async function probeTcp(conn, options) {
  const { socket, elapsedMs } = await connect(conn, options.timeoutMs)
  try {
    if (typeof conn.send === 'string' && conn.send !== '') {
      socket.write(conn.send)
    }
    const banner = await new Promise((resolve) => {
      let collected = ''
      const timer = setTimeout(() => {
        cleanup()
        resolve(collected)
      }, Math.min(1500, options.timeoutMs))
      const cleanup = () => {
        clearTimeout(timer)
        socket.removeListener('data', onData)
        socket.removeListener('error', onNoop)
      }
      const onData = (chunk) => {
        collected += chunk.toString('utf8')
        if (collected.length >= 1024) {
          cleanup()
          resolve(collected.slice(0, 1024))
        }
      }
      const onNoop = () => {
        cleanup()
        resolve(collected)
      }
      socket.on('data', onData)
      socket.on('error', onNoop)
      if (typeof conn.send !== 'string' || conn.send === '') {
        // 不主动发数据时，立刻认为「端口通」就够了
        cleanup()
        resolve('')
      }
    })
    const printable = banner.replace(/[^\x20-\x7e\r\n]+/g, ' ').trim()
    return {
      detail: `端口可达${printable === '' ? '' : ` · banner: ${printable.slice(0, 200)}`}`,
      elapsedMs,
    }
  } finally {
    socket.destroy()
  }
}
