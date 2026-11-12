/** TCP 预检：把「端口不通」和「握手/认证失败」分开报，排查快很多。 */

import net from 'node:net'

export async function assertTcpReachable(host, port, timeoutMs) {
  const budget = Math.max(1000, Math.min(5000, Number(timeoutMs) || 5000))
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error === undefined) resolve()
      else reject(error)
    }
    const timer = setTimeout(() => {
      finish(
        new Error(
          `连不上 ${host}:${port}（${budget}ms 内 TCP 无响应）：确认网络/VPN 是否通、端口有没有被防火墙拦，必要时把连接的超时时间调大`,
        ),
      )
    }, budget)
    socket.once('connect', () => finish())
    socket.once('error', (error) => {
      finish(new Error(`连不上 ${host}:${port}：${error.message}`))
    })
  })
}
