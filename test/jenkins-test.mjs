/**
 * Jenkins 驱动自测：起一个假 Jenkins，验证 jobs/job/build/log/queue 与 allowTrigger 护栏。
 * 不连任何外部服务。
 */

import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const driver = (await import(pathToFileURL(path.join(here, '..', 'lib', 'drivers', 'jenkins.js')).href)).default

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

let triggered = 0
let crumbChecks = 0
let expectCrumb = false

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }

  if (url.pathname === '/api/json') {
    if (url.searchParams.get('tree')?.includes('mode')) return send(200, { mode: 'NORMAL', nodeDescription: 'fake' })
    if (url.searchParams.get('tree')?.includes('jobs')) {
      return send(200, {
        jobs: [
          { name: 'deploy-140', color: 'blue', url: 'http://x/job/deploy-140/' },
          { name: 'restart-aigc', color: 'red_anime', url: 'http://x/job/restart-aigc/' },
        ],
      })
    }
  }
  if (url.pathname === '/job/deploy-140/api/json') {
    return send(200, {
      name: 'deploy-140',
      color: 'blue',
      lastBuild: { number: 7, result: 'SUCCESS', building: false, duration: 12345, url: 'http://x/job/deploy-140/7/' },
    })
  }
  if (url.pathname === '/job/restart-aigc/api/json') {
    return send(401, { error: 'unauthorized' })
  }
  if (url.pathname === '/crumbIssuer/api/json') {
    return send(200, { crumbRequestField: 'Jenkins-Crumb', crumb: 'abc123' })
  }
  if (req.method === 'POST' && url.pathname.startsWith('/job/')) {
    if (expectCrumb && req.headers['jenkins-crumb'] !== 'abc123') {
      return send(403, 'No valid crumb was included in the request', 'text/plain')
    }
    crumbChecks += 1
    triggered += 1
    return send(201, '')
  }
  if (url.pathname === '/job/deploy-140/lastBuild/consoleText') {
    return send(200, ['line1', 'line2', 'Started by user', 'Finished: SUCCESS'].join('\n'), 'text/plain')
  }
  if (url.pathname === '/queue/api/json') {
    return send(200, { items: [{ id: 1, why: 'Waiting for next available executor', task: { name: 'deploy-140' } }] })
  }
  send(404, { error: `no route ${req.method} ${url.pathname}` })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const readOnly = driver.validate({ name: 'ci', kind: 'jenkins', baseUrl: base })
const writable = driver.validate({ name: 'ci', kind: 'jenkins', baseUrl: base, allowTrigger: true })

try {
  const probe = await driver.probe(readOnly, {})
  check('probe 显示只读且可达', /Jenkins 可达/.test(probe.detail) && /只读/.test(probe.detail), probe.detail)

  const jobs = await driver.call(readOnly, 'jobs', {}, {})
  check('jobs 列出并翻译状态', /成功\s+deploy-140/.test(jobs.text) && /构建中\s+restart-aigc/.test(jobs.text), jobs.text.replace(/\n/g, ' | '))

  const job = await driver.call(readOnly, 'job', { job: 'deploy-140' }, {})
  check('job 显示最近构建', /#7 · SUCCESS/.test(job.text), job.text.replace(/\n/g, ' | '))

  const log = await driver.call(readOnly, 'log', { job: 'deploy-140', lines: 2 }, {})
  check('log 只取尾部', /Finished: SUCCESS/.test(log.text) && !/line1/.test(log.text), log.text.replace(/\n/g, ' | '))

  const queue = await driver.call(readOnly, 'queue', {}, {})
  check('queue 列出排队', /deploy-140/.test(queue.text), queue.text)

  let refused = ''
  try {
    await driver.call(readOnly, 'build', { job: 'deploy-140' }, {})
  } catch (error) {
    refused = `${error.message}`
  }
  check('未开 allowTrigger 拒绝构建', /allowTrigger/.test(refused), refused)

  triggered = 0
  const built = await driver.call(writable, 'build', { job: 'deploy-140' }, {})
  check('开启后可以触发', triggered === 1 && /已触发 deploy-140/.test(built.text), built.text)

  triggered = 0
  expectCrumb = true
  const withCrumb = await driver.call(writable, 'build', { job: 'deploy-140', params: { env: 'test' } }, {})
  check('403 时自动取 crumb 重试', triggered === 1 && crumbChecks >= 1 && /已触发/.test(withCrumb.text), withCrumb.text)
  expectCrumb = false

  let authError = ''
  try {
    await driver.probe(driver.validate({ name: 'ci2', kind: 'jenkins', baseUrl: base + '/x' }), {})
  } catch (error) {
    authError = `${error.message}`
  }
  check('错误不会泄露密码', !/c_ds9|C&Z5|PlPDWUh/.test(authError), authError.slice(0, 60))
} finally {
  server.closeAllConnections?.()
  server.close()
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) process.exit(1)
