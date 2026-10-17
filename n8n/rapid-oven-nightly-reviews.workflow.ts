import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

// Rapid Oven – Nightly Review Texts. Every night at 7:10pm Sydney (just after the Job Count Tracker's
// 7pm run) texts each of today's booked customers the day's Google review template via MobileMessage,
// stamps reviewSentAt + a history line on their CRM lead (so Today > Reviews shows them as sent), and
// posts a summary to Telegram. Build Review Texts has DRY_RUN at the top: true = Telegram list only.

const nightly = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every Night 7:10pm',
    position: [0, 300],
    parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 10 19 * * *' }] } },
  },
  output: [{ timestamp: '2026-10-17T19:10:00.000+11:00' }],
});

const fetchOpts = { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput', alwaysOutputData: true };

const fetchJobCount = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Job Count Row',
    position: [240, 300],
    ...fetchOpts,
    parameters: {
      url: 'https://haarvltpfcbixqbwkxpl.supabase.co/rest/v1/job_count_daily',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendQuery: true,
      queryParameters: { parameters: [
        { name: 'select', value: 'date,jobs,updated_at' },
        { name: 'date', value: expr("eq.{{ $now.setZone('Australia/Sydney').toISODate() }}") },
      ] },
      options: {},
    },
    credentials: { httpCustomAuth: { id: '8XVsZkDXlvSmJXhN', name: 'Custom Auth account' } },
  },
  output: [{ date: '2026-10-17', jobs: [{ time: '08:00', customer: 'Smith, Jane', description: 'Oven clean', status: 'Quote', phone: '0412 345 678', leadId: 'sm8_x', staff: 'Aaron' }], updated_at: '2026-10-17T08:03:00Z' }],
});

const fetchLeads = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Job Leads',
    position: [480, 300],
    executeOnce: true,
    ...fetchOpts,
    parameters: {
      url: 'https://haarvltpfcbixqbwkxpl.supabase.co/rest/v1/leads',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendQuery: true,
      queryParameters: { parameters: [
        { name: 'select', value: 'id,data' },
        { name: 'id', value: expr("in.({{ $('Fetch Job Count Row').all().flatMap(i => (i.json && i.json.jobs) || []).map(j => j.leadId).filter(id => /^[A-Za-z0-9_-]+$/.test(id || '')).concat(['none']).join(',') }})") },
      ] },
      options: {},
    },
    credentials: { httpCustomAuth: { id: '8XVsZkDXlvSmJXhN', name: 'Custom Auth account' } },
  },
  output: [{ id: 'sm8_x', data: { name: 'Smith, Jane', phone: '0412 345 678', history: [] } }],
});

const fetchRecent = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Recent Review Texts',
    position: [720, 300],
    executeOnce: true,
    ...fetchOpts,
    parameters: {
      url: 'https://haarvltpfcbixqbwkxpl.supabase.co/rest/v1/leads',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendQuery: true,
      queryParameters: { parameters: [
        { name: 'select', value: 'id,phone:data->>phone,sentAt:data->>reviewSentAt' },
        { name: 'data->>reviewSentAt', value: expr('gte.{{ $now.toMillis() - 180 * 86400000 }}') },
        { name: 'order', value: 'id' },
        { name: 'limit', value: '1000' },
      ] },
      options: {
        pagination: { pagination: {
          paginationMode: 'updateAParameterInEachRequest',
          parameters: { parameters: [{ type: 'qs', name: 'offset', value: expr('{{ $pageCount * 1000 }}') }] },
          paginationCompleteWhen: 'other',
          completeExpression: expr('{{ !Array.isArray($response.body) || $response.body.length < 1000 }}'),
          limitPagesFetched: true,
          maxRequests: 20,
        } },
      },
    },
    credentials: { httpCustomAuth: { id: '8XVsZkDXlvSmJXhN', name: 'Custom Auth account' } },
  },
  output: [{ id: 'sm8_y', phone: '0412 345 678', sentAt: '1792212808988' }],
});

const fetchTemplates = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Templates',
    position: [960, 300],
    executeOnce: true,
    ...fetchOpts,
    parameters: {
      url: 'https://haarvltpfcbixqbwkxpl.supabase.co/rest/v1/config',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'select', value: 'id,data' }] },
      options: {},
    },
    credentials: { httpCustomAuth: { id: '8XVsZkDXlvSmJXhN', name: 'Custom Auth account' } },
  },
  output: [{ id: 'default', data: { tpls: [{ name: 'Review 1', text: 'Hi {name}...' }] } }],
});

const fetchOptOuts = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Opt-outs',
    position: [1200, 300],
    executeOnce: true,
    ...fetchOpts,
    parameters: {
      url: 'https://haarvltpfcbixqbwkxpl.supabase.co/rest/v1/bulk_sms_suppressions',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'select', value: 'canonical_number' }, { name: 'limit', value: '1000' }] },
      options: {},
    },
    credentials: { httpCustomAuth: { id: '8XVsZkDXlvSmJXhN', name: 'Custom Auth account' } },
  },
  output: [{ canonical_number: '61400000000' }],
});

const buildTexts = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Review Texts',
    position: [1440, 300],
    executeOnce: true,
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: 
        "// Builds tonight's review texts from today's Job Count row. One output item: the plan for this run.\n" +
        "// DRY_RUN = true: nothing is sent, Telegram just lists who would get a text.\n" +
        "const DRY_RUN = false;\n" +
        "const REPEAT_DAYS = 180;      // skip numbers that got a review text (nightly or Today > Reviews) in the last 180 days\n" +
        "const MAX_DATA_AGE_MIN = 120; // Job Count Tracker runs hourly; older data means it has stalled, so don't send from it\n" +
        "const SENDER = 'OvenClean';\n" +
        "// Same as REVIEW_TPLS in the CRM's index.html (1 SMS credit: 160 plain characters or fewer): used when the saved templates don't have them.\n" +
        "const REVIEW_DEFAULTS = ['CRBQWvLOqAS0EAg', 'CQsQOEtqCFXJEBM', 'CcLwkZN5Ij_3EAI'].map((g, i) => ({ name: 'Review ' + (i + 1),\n" +
        "  text: 'Hi {name}, thanks for choosing Rapid Oven Cleaning! How did we go? A quick Google review would mean a lot: https://g.page/r/' + g + '/review' }));\n" +
        "\n" +
        "const now = $now.setZone('Australia/Sydney');\n" +
        "const today = now.toISODate();\n" +
        "const sydDate = ms => DateTime.fromMillis(ms, { zone: 'Australia/Sydney' }).toISODate();\n" +
        "\n" +
        "// Any failed lookup stops the send: sending without the opt-out or already-texted lists could text the wrong people.\n" +
        "const fetched = {};\n" +
        "const problems = [];\n" +
        "for (const [key, nodeName, label] of [['jc', 'Fetch Job Count Row', \"today's jobs\"], ['leads', 'Fetch Job Leads', 'the CRM leads'],\n" +
        "  ['recent', 'Fetch Recent Review Texts', 'recent review texts'], ['cfg', 'Fetch Templates', 'the SMS templates'], ['opt', 'Fetch Opt-outs', 'the opt-out list']]) {\n" +
        "  const rows = $(nodeName).all().map(i => i.json || {});\n" +
        "  if (rows.some(r => r.error)) problems.push(\"couldn't load \" + label);\n" +
        "  fetched[key] = rows.filter(r => r && !r.error && Object.keys(r).length);\n" +
        "}\n" +
        "\n" +
        "const dayRow = fetched.jc.find(r => r.date === today);\n" +
        "if (!problems.length && !dayRow) problems.push(\"no Job Count data for today (is the Job Count Tracker running?)\");\n" +
        "if (!problems.length && dayRow) {\n" +
        "  const ageMin = (Date.now() - Date.parse(dayRow.updated_at)) / 60000;\n" +
        "  if (!(ageMin <= MAX_DATA_AGE_MIN)) problems.push(\"today's job data is \" + (isFinite(ageMin) ? Math.round(ageMin) + ' min' : 'too') + ' old (Job Count Tracker may have stalled)');\n" +
        "}\n" +
        "\n" +
        "// Template: same pick as the CRM's todayReviewTpl(), Review 1 -> 2 -> 3 -> 1... one per day from 15 Oct 2026.\n" +
        "const cfgRow = fetched.cfg.find(r => r.id === 'default') || fetched.cfg[0];\n" +
        "const tpls = cfgRow && cfgRow.data && Array.isArray(cfgRow.data.tpls) ? cfgRow.data.tpls.slice() : REVIEW_DEFAULTS.slice();\n" +
        "REVIEW_DEFAULTS.forEach(r => { if (!tpls.some(t => t && t.name === r.name)) tpls.push(r); });\n" +
        "const pool = tpls.filter(t => t && /^review \\d+$/i.test(t.name || ''));\n" +
        "const dayNo = Math.round((Date.UTC(now.year, now.month - 1, now.day) - Date.UTC(2026, 9, 15)) / 864e5);\n" +
        "const tpl = pool[((dayNo % pool.length) + pool.length) % pool.length];\n" +
        "// MobileMessage drops curly quotes, dashes etc., so send plain characters only.\n" +
        "const plain = s => String(s || '').replace(/[\\u2018\\u2019\\u201B\\u2032]/g, \"'\").replace(/[\\u201C\\u201D\\u2033]/g, '\"')\n" +
        "  .replace(/[\\u2013\\u2014\\u2212]/g, '-').replace(/\\u2026/g, '...').replace(/\\u00A0/g, ' ');\n" +
        "\n" +
        "// Must match firstNameOf()/personaliseSmsText() in index.html (only {name} etc. are filled).\n" +
        "function firstNameOf(name) {\n" +
        "  name = (name || '').trim();\n" +
        "  if (!name) return 'there';\n" +
        "  if (name.includes(',')) { const after = (name.split(',')[1] || '').trim().split(/\\s+/)[0]; if (after) return after; }\n" +
        "  return name.split(/\\s+/)[0] || 'there';\n" +
        "}\n" +
        "function fmtD(s) { const p = s.split('-'); return (+p[2]) + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+p[1] - 1]; }\n" +
        "function fmtTime12(t) { const [h, mm] = t.split(':'); let hh = +h; const ap = hh >= 12 ? 'pm' : 'am'; hh = hh % 12 || 12; return hh + (mm !== '00' ? ':' + mm : '') + ap; }\n" +
        "function personalise(l, text) {\n" +
        "  const map = {\n" +
        "    '{name}': firstNameOf(l.name),\n" +
        "    '{service}': (l.service || '').toLowerCase(),\n" +
        "    '{value}': l.value ? ' ($' + (+l.value).toLocaleString() + ')' : '',\n" +
        "    '{suburb}': l.suburb || '',\n" +
        "    '{address}': l.address || '',\n" +
        "    '{jobwhen}': l.jobDate ? ' for ' + fmtD(l.jobDate) + (l.jobTime ? ' at ' + fmtTime12(l.jobTime) : '') : '',\n" +
        "  };\n" +
        "  return text.replace(/\\{name\\}|\\{service\\}|\\{value\\}|\\{suburb\\}|\\{address\\}|\\{jobwhen\\}/g, m => map[m] ?? m);\n" +
        "}\n" +
        "// Phone fields can hold two numbers (\"0412 345 678, 02 9xxx xxxx\"); use the first mobile.\n" +
        "function mobileOf(raw) {\n" +
        "  for (const part of String(raw || '').split(/[,;\\/]|\\bor\\b/i)) {\n" +
        "    let d = part.replace(/\\D/g, '');\n" +
        "    if (d.startsWith('0')) d = '61' + d.slice(1);\n" +
        "    else if (d.length === 9 && d.startsWith('4')) d = '61' + d;\n" +
        "    if (/^614\\d{8}$/.test(d)) return d;\n" +
        "  }\n" +
        "  return '';\n" +
        "}\n" +
        "\n" +
        "const leadMap = new Map(fetched.leads.filter(r => r.id).map(r => [String(r.id), r.data || {}]));\n" +
        "const optOut = new Set(fetched.opt.map(r => r.canonical_number).filter(Boolean));\n" +
        "const cutoff = now.toMillis() - REPEAT_DAYS * 864e5;\n" +
        "const lastSent = new Map(); // mobile -> latest review text (ms)\n" +
        "for (const r of fetched.recent) {\n" +
        "  const n = mobileOf(r.phone), at = Number(r.sentAt);\n" +
        "  if (n && at >= cutoff && at > (lastSent.get(n) || 0)) lastSent.set(n, at);\n" +
        "}\n" +
        "\n" +
        "const jobs = ((dayRow && dayRow.jobs) || []).slice().sort((a, b) => String(a.time).localeCompare(String(b.time)));\n" +
        "const byNumber = new Map();\n" +
        "const skipped = [];\n" +
        "for (const j of jobs) {\n" +
        "  const lead = j.leadId ? leadMap.get(j.leadId) : null;\n" +
        "  const rawName = (lead && lead.name) || j.customer || '';\n" +
        "  const name = /^unknown$/i.test(rawName.trim()) ? '' : rawName;\n" +
        "  const who = name || j.customer || 'Unknown';\n" +
        "  const to = mobileOf(lead && lead.phone) || mobileOf(j.phone);\n" +
        "  if (!to) { skipped.push({ who, reason: 'no mobile number' }); continue; }\n" +
        "  if (optOut.has(to)) { skipped.push({ who, reason: 'opted out' }); continue; }\n" +
        "  const prev = Math.max(lastSent.get(to) || 0, Number(lead && lead.reviewSentAt) || 0);\n" +
        "  if (prev && sydDate(prev) === today) { skipped.push({ who, reason: 'already texted today' }); continue; }\n" +
        "  if (prev >= cutoff) { skipped.push({ who, reason: 'texted ' + sydDate(prev).split('-').reverse().slice(0, 2).join('/') }); continue; }\n" +
        "  if (byNumber.has(to)) { const m = byNumber.get(to); if (j.leadId) m.leadIds.push(j.leadId); continue; }\n" +
        "  const src = lead || { name, service: j.description || 'oven clean' };\n" +
        "  byNumber.set(to, {\n" +
        "    operation_id: 'rev-' + today + ':' + to,\n" +
        "    to,\n" +
        "    message: plain(personalise({ ...src, name }, (tpl && tpl.text) || '')).trim(),\n" +
        "    who,\n" +
        "    leadIds: j.leadId ? [j.leadId] : [],\n" +
        "  });\n" +
        "}\n" +
        "const messages = [...byNumber.values()].filter(m => m.message);\n" +
        "const problem = problems.join('; ');\n" +
        "\n" +
        "return [{ json: {\n" +
        "  today,\n" +
        "  dryRun: DRY_RUN,\n" +
        "  send: !DRY_RUN && !problem && messages.length > 0,\n" +
        "  problem,\n" +
        "  templateName: (tpl && tpl.name) || '',\n" +
        "  jobCount: jobs.length,\n" +
        "  messages,\n" +
        "  skipped,\n" +
        "  idempotencyKey: 'nightly-review-' + today,\n" +
        "  // shorten_urls 'auto': MobileMessage swaps the Google link for a 22-char https://addr.au/... link (counted after shortening,\n" +
        "  // clicks tracked, expires after 90 days); if it can't, the text still goes with the full link.\n" +
        "  providerPayload: { shorten_urls: 'auto', messages: messages.map(m => ({ to: m.to, message: m.message, sender: SENDER, custom_ref: m.operation_id })) },\n" +
        "} }];" },
  },
  output: [{ today: '2026-10-17', dryRun: true, send: false, problem: '', templateName: 'Review 3', jobCount: 1, messages: [{ operation_id: 'rev-2026-10-17:61412345678', to: '61412345678', message: 'Hi Jane...', who: 'Smith, Jane', leadIds: ['sm8_x'] }], skipped: [], idempotencyKey: 'nightly-review-2026-10-17', providerPayload: { messages: [{ to: '61412345678', message: 'Hi Jane...', sender: 'OvenClean', custom_ref: 'rev-2026-10-17:61412345678' }] } }],
});

const sendForReal = ifElse({
  version: 2.2,
  config: {
    name: 'Send for Real?',
    position: [1680, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: expr('{{ $json.send }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
    },
  },
});

// Never retried: a retry could double-text. The Idempotency-Key also stops a same-day re-run sending twice.
const sendSms = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Send via MobileMessage',
    position: [1920, 200],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: 'https://api.mobilemessage.com.au/v1/messages',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBasicAuth',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'Idempotency-Key', value: expr('{{ $json.idempotencyKey }}') }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.providerPayload) }}'),
      options: { timeout: 30000 },
    },
    credentials: { httpBasicAuth: { id: 'dofAyZj4adLInpAg', name: 'Unnamed credential' } },
  },
  output: [{ status: 'complete', results: [{ to: '61412345678', custom_ref: 'rev-2026-10-17:61412345678', status: 'success', message_id: 'mm_1', cost: 2 }] }],
});

const recordResults = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Record Results',
    position: [2160, 200],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: 
        "// What MobileMessage said for each text, plus the CRM lead updates (reviewSentAt + history) for the accepted ones.\n" +
        "const plan = $('Build Review Texts').first().json;\n" +
        "const res = $input.first().json || {};\n" +
        "let results, note = '';\n" +
        "if (Array.isArray(res.results)) {\n" +
        "  results = res.results.map(r => {\n" +
        "    const s = String(r.status || '').toLowerCase();\n" +
        "    return {\n" +
        "      operation_id: r.custom_ref || '',\n" +
        "      // blocked = the number unsubscribed with MobileMessage, so it was never sent.\n" +
        "      status: ['queued', 'sent', 'accepted', 'success'].includes(s) ? 'accepted' : s === 'blocked' ? 'blocked' : ['failed', 'rejected', 'invalid', 'error'].includes(s) ? 'failed' : 'unknown',\n" +
        "      message_id: r.message_id || null,\n" +
        "    };\n" +
        "  });\n" +
        "} else {\n" +
        "  // A clear refusal (bad login, no credit, bad request, rate limit) means nothing went out. Anything else might have, so it's unknown.\n" +
        "  const err = res.error || {};\n" +
        "  const code = Number(err.httpCode || err.status || (String(err.message || '').match(/\\b([45]\\d\\d)\\b/) || [])[1] || 0);\n" +
        "  const definite = [400, 401, 402, 403, 429].includes(code);\n" +
        "  results = plan.messages.map(m => ({ operation_id: m.operation_id, status: definite ? 'failed' : 'unknown', message_id: null }));\n" +
        "  note = definite ? 'MobileMessage refused the request (HTTP ' + code + ').' : 'MobileMessage did not give a clear answer, so check it before resending.';\n" +
        "}\n" +
        "const reported = new Set(results.map(r => r.operation_id));\n" +
        "plan.messages.filter(m => !reported.has(m.operation_id)).forEach(m => results.push({ operation_id: m.operation_id, status: 'unknown', message_id: null }));\n" +
        "\n" +
        "const leads = new Map($('Fetch Job Leads').all().map(i => i.json || {}).filter(r => r.id).map(r => [String(r.id), r.data || {}]));\n" +
        "const accepted = new Set(results.filter(r => r.status === 'accepted').map(r => r.operation_id));\n" +
        "const nowMs = Date.now(), nowIso = new Date(nowMs).toISOString();\n" +
        "const upserts = [];\n" +
        "for (const m of plan.messages) {\n" +
        "  if (!accepted.has(m.operation_id)) continue;\n" +
        "  for (const id of m.leadIds) {\n" +
        "    const data = leads.get(id);\n" +
        "    if (!data) continue;\n" +
        "    // Same history entry shape as logAct() in the CRM (newest last, max 60).\n" +
        "    const history = (Array.isArray(data.history) ? data.history : []).concat([{ ts: nowMs, text: 'Texted review request (nightly auto, ' + plan.templateName + ')' }]).slice(-60);\n" +
        "    upserts.push({ id, data: { ...data, reviewSentAt: nowMs, history }, updated_at: nowIso });\n" +
        "  }\n" +
        "}\n" +
        "return [{ json: { results, note, upserts } }];" },
  },
  output: [{ results: [{ operation_id: 'rev-2026-10-17:61412345678', status: 'accepted', message_id: 'mm_1' }], note: '', upserts: [{ id: 'sm8_x', data: { name: 'Smith, Jane', reviewSentAt: 1792212808988, history: [] }, updated_at: '2026-10-17T08:10:00.000Z' }] }],
});

const markSent = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Mark Sent in CRM',
    position: [2400, 200],
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
    onError: 'continueRegularOutput',
    alwaysOutputData: true,
    parameters: {
      method: 'POST',
      url: 'https://haarvltpfcbixqbwkxpl.supabase.co/rest/v1/leads',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'on_conflict', value: 'id' }] },
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'Prefer', value: 'resolution=merge-duplicates,return=minimal' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.upserts) }}'),
      options: {},
    },
    credentials: { httpCustomAuth: { id: '8XVsZkDXlvSmJXhN', name: 'Custom Auth account' } },
  },
  output: [{}],
});

const buildSummary = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Telegram Summary',
    position: [2640, 300],
    executeOnce: true,
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: 
        "// One Telegram message per night: what was sent (or would be, on a dry run), what was skipped and why.\n" +
        "const plan = $('Build Review Texts').first().json;\n" +
        "const rec = $('Record Results').isExecuted ? $('Record Results').first().json : null;\n" +
        "const stamp = $('Mark Sent in CRM').isExecuted ? ($('Mark Sent in CRM').first().json || {}) : null;\n" +
        "const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\n" +
        "const fmt = n => (n && n.length === 11 ? '0' + n.slice(2, 5) + ' ' + n.slice(5, 8) + ' ' + n.slice(8) : n || '?');\n" +
        "const day = DateTime.fromISO(plan.today, { zone: 'Australia/Sydney' }).toFormat('ccc d LLL');\n" +
        "const byOp = new Map(plan.messages.map(m => [m.operation_id, m]));\n" +
        "const names = arr => arr.map(m => esc(m.who) + ' ' + fmt(m.to)).join('\\n');\n" +
        "\n" +
        "const lines = ['⭐ <b>Nightly review texts</b> - ' + esc(day) + (plan.templateName ? ' (' + esc(plan.templateName) + ')' : '')];\n" +
        "if (plan.problem) {\n" +
        "  lines.push('⚠️ Nothing sent: ' + esc(plan.problem));\n" +
        "} else if (!plan.jobCount) {\n" +
        "  lines.push('No jobs booked today, nothing to send.');\n" +
        "} else if (!plan.messages.length) {\n" +
        "  lines.push('Nobody left to text tonight.');\n" +
        "} else if (!rec) {\n" +
        "  lines.push('🧪 DRY RUN, nothing was sent. Would text ' + plan.messages.length + ':');\n" +
        "  lines.push(names(plan.messages));\n" +
        "} else {\n" +
        "  const pick = s => rec.results.filter(r => r.status === s).map(r => byOp.get(r.operation_id)).filter(Boolean);\n" +
        "  const ok = pick('accepted'), bad = pick('failed'), unk = pick('unknown'), blk = pick('blocked');\n" +
        "  lines.push('✅ ' + ok.length + ' of ' + plan.messages.length + ' sent');\n" +
        "  if (bad.length) lines.push('❌ ' + bad.length + ' rejected:\\n' + names(bad));\n" +
        "  if (blk.length) lines.push('🚫 ' + blk.length + ' opted out, not sent:\\n' + names(blk));\n" +
        "  if (unk.length) lines.push('⚠️ ' + unk.length + ' not confirmed, check MobileMessage before resending:\\n' + names(unk));\n" +
        "  if (rec.note) lines.push(esc(rec.note));\n" +
        "  if (rec.upserts.length && stamp && stamp.error) lines.push(\"⚠️ Couldn't mark them as sent in the CRM, so Today > Reviews may still show Send.\");\n" +
        "}\n" +
        "if (plan.skipped.length) lines.push('Skipped ' + plan.skipped.length + ': ' + plan.skipped.map(s => esc(s.who) + ' (' + esc(s.reason) + ')').join(', '));\n" +
        "return [{ json: { text: lines.join('\\n').slice(0, 4000) } }];" },
  },
  output: [{ text: 'Nightly review texts - Sat 17 Oct (Review 3)' }],
});

const telegram = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Telegram Summary',
    position: [2880, 300],
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: '7851062237',
      text: expr('{{ $json.text }}'),
      additionalFields: { parse_mode: 'HTML', appendAttribution: false },
    },
    credentials: { telegramApi: { id: 'DyMj6r67ntqs4ryH', name: 'Telegram account 4' } },
  },
  output: [{ ok: true }],
});

const readme = sticky(
  '## Nightly review texts\n\n' +
    "7:10pm Sydney: texts today's Job Count jobs (Quote, Work Order, Completed) the day's Review 1/2/3\n" +
    'template (same rotation as Today > Reviews), via MobileMessage as OvenClean.\n' +
    'Skips: no mobile, opted out (bulk_sms_suppressions), already texted today (e.g. from Today > Reviews),\n' +
    'texted in the last 180 days, duplicate numbers. Any failed lookup or job data older than 2h = nothing sent.\n' +
    'DRY_RUN at the top of Build Review Texts: true = Telegram list only, nothing sent.',
  [nightly, fetchJobCount, fetchLeads, fetchRecent, fetchTemplates, fetchOptOuts, buildTexts],
  { color: 5 },
);

export default workflow('rapid-oven-nightly-reviews', 'Rapid Oven – Nightly Review Texts')
  .add(nightly)
  .to(fetchJobCount)
  .to(fetchLeads)
  .to(fetchRecent)
  .to(fetchTemplates)
  .to(fetchOptOuts)
  .to(buildTexts)
  .to(
    sendForReal
      .onTrue(sendSms.to(recordResults.to(markSent.to(buildSummary.to(telegram)))))
      .onFalse(buildSummary),
  )
  .add(readme);
