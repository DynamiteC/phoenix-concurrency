// Demo server for the concurrency dashboard. No dependencies: node's https talks to the
// ClickHouse HTTP endpoint directly. Credentials stay here and never reach the browser,
// which is the whole reason this process exists instead of a static page.
//
//   node demo/server.js            # http://localhost:3100
//   CH_DATABASE=phoenix node demo/server.js   # the validated tables instead of the replay
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const { CH_HOST, CH_USER = 'default', CH_PASSWORD = '' } = process.env
const DB = process.env.CH_DATABASE || 'phoenix_demo'
const PORT = Number(process.env.PORT || 3100)

const SQL = {
  curve: fs.readFileSync(path.join(ROOT, 'sql/queries/benchmark/concurrency_curve.sql'), 'utf8'),
  peak: fs.readFileSync(path.join(ROOT, 'sql/queries/benchmark/peak_average.sql'), 'utf8'),
}

function query(sql, params) {
  const qs = new URLSearchParams({ database: DB, session_timezone: 'UTC', default_format: 'JSONCompact' })
  for (const [k, v] of Object.entries(params || {})) qs.append(`param_${k}`, String(v))
  const opts = {
    hostname: CH_HOST, port: 8443, path: `/?${qs}`, method: 'POST',
    headers: { 'X-ClickHouse-User': CH_USER, 'X-ClickHouse-Key': CH_PASSWORD },
  }
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(body.slice(0, 400)))
        try { resolve(JSON.parse(body)) } catch (e) { reject(new Error(`bad JSON: ${body.slice(0, 200)}`)) }
      })
    })
    req.on('error', reject)
    req.end(sql)
  })
}

// Filters arrive from the browser and go straight into query parameters, never into the SQL
// text: the statements are fixed files, so a crafted platform value cannot change the query.
function filters(u) {
  return {
    platform: u.searchParams.get('platform') || '',
    country: u.searchParams.get('country') || '',
    video_type: u.searchParams.get('video_type') || '',
    app_version: u.searchParams.get('app_version') || '',
    content_id: Number(u.searchParams.get('content_id') || 0) || 0,
    from_ts: u.searchParams.get('from') || '2000-01-01 00:00:00',
    to_ts: u.searchParams.get('to') || '2100-01-01 00:00:00',
  }
}

const routes = {
  '/api/curve': async (u) => {
    const t0 = Date.now()
    const r = await query(SQL.curve, filters(u))
    return { points: r.data.map(([m, c]) => [m, Number(c)]), ms: Date.now() - t0, rows_read: r.statistics?.rows_read }
  },
  '/api/peak': async (u) => {
    const t0 = Date.now()
    const r = await query(SQL.peak, { ...filters(u), grain_s: Number(u.searchParams.get('grain_s') || 86400) })
    return { rows: r.data, ms: Date.now() - t0, rows_read: r.statistics?.rows_read }
  },
  // what the replay has ingested so far, so the page can show ingestion keeping up
  '/api/status': async () => {
    const t0 = Date.now()
    const r = await query(
      `SELECT (SELECT count() FROM raw_events)          AS events,
              (SELECT max(event_timestamp) FROM raw_events) AS latest,
              (SELECT sum(sign) FROM session_minute_runs)   AS runs,
              (SELECT count() FROM concurrency_deltas)      AS deltas`, {})
    return { ...Object.fromEntries(r.meta.map((c, i) => [c.name, r.data[0][i]])), ms: Date.now() - t0 }
  },
  '/api/dimensions': async () => {
    const r = await query(
      `SELECT 'platform' AS dim, platform AS value FROM concurrency_deltas GROUP BY 1,2
       UNION ALL SELECT 'country', country FROM concurrency_deltas GROUP BY 1,2
       UNION ALL SELECT 'video_type', video_type FROM concurrency_deltas GROUP BY 1,2
       ORDER BY 1, 2`, {})
    return { values: r.data }
  },
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost')
  try {
    if (routes[u.pathname]) {
      const body = JSON.stringify(await routes[u.pathname](u))
      res.writeHead(200, { 'content-type': 'application/json' }).end(body)
      return
    }
    const file = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\//, '')
    const full = path.join(__dirname, path.normalize(file).replace(/^(\.\.[/\\])+/, ''))
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/plain' })
    res.end(fs.readFileSync(full))
  } catch (e) {
    console.error(`${u.pathname}: ${e.message || e}`)
    if (res.headersSent) return res.end()   // a throw after the body started must not re-send headers
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e.message || e) }))
  }
}).listen(PORT, () => console.log(`phoenix demo on http://localhost:${PORT}  (database: ${DB})`))
