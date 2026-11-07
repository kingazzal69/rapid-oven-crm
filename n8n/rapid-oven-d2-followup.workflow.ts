import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

// Rapid Oven – D2 Follow Up (funnel stage 2; stage 1 is Instant Lead Reply). Every 15 min from 5pm to 8pm Sydney, texts each
// Contacted lead whose D1 was ticked 2+ calendar days ago and has no D2, one follow-up text from Aaron own mobile number, so replies reach him.
// Accepted texts tick D2, move the lead Contacted -> Follow Up and add history lines. One Telegram note per lead.
// Build Follow Ups has DRY_RUN at the top (true = nobody texted, nothing changed, Telegram lists who it would text),
// START_DATE (only D1 ticks from that Sydney date) and BACKLOG_IDS (older leads Aaron asks to include).

const every15 = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 15 Min 5-8pm',
    position: [0, 300],
    // Minute 1, 16, 31, 46 at :15 (same slot as Instant Lead Reply, which only touches New leads), so it never overlaps
    // Lead Sync (minute 0, 3, 6... at about :47, rewrites whole lead rows) or Booking Merge (minute 2, 5, 8...).
    parameters: { rule: { interval: [{ field: 'cronExpression', expression: '15 1,16,31,46 17-19 * * *' }] } },
  },
  output: [{ timestamp: '2026-11-04T17:01:15.000+11:00' }],
});

const fetchOpts = { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput', alwaysOutputData: true };

const fetchLeads = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Recent Leads',
    position: [240, 300],
    ...fetchOpts,
    parameters: {
      url: 'https://haarvltpfcbixqbwkxpl.supabase.co/rest/v1/leads',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendQuery: true,
      queryParameters: { parameters: [
        { name: 'select', value: 'id,data' },
        { name: 'data->>createdAt', value: expr('gte.{{ $now.toMillis() - 60 * 86400000 }}') },
        { name: 'data->>archived', value: 'is.null' },
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
          maxRequests: 10,
        } },
      },
    },
    credentials: { httpCustomAuth: { id: '8XVsZkDXlvSmJXhN', name: 'Custom Auth account' } },
  },
  output: [{ id: 'sm8_x', data: { name: 'Smith, Jane', phone: '+61412345678', stage: 'contacted', d1: true, d1At: 1793930000000, createdAt: 1793929000000 } }],
});

const fetchBooked = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Booked Jobs',
    position: [480, 300],
    executeOnce: true,
    ...fetchOpts,
    parameters: {
      url: 'https://haarvltpfcbixqbwkxpl.supabase.co/rest/v1/job_count_daily',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'select', value: 'date,jobs' }] },
      options: {},
    },
    credentials: { httpCustomAuth: { id: '8XVsZkDXlvSmJXhN', name: 'Custom Auth account' } },
  },
  output: [{ date: '2026-11-04', jobs: [{ time: '08:00', customer: 'Smith, Jane', status: 'Quote', phone: '0412345678', leadId: 'sm8_y' }] }],
});

const fetchOptOuts = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Opt-outs',
    position: [720, 300],
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

const buildFollowUps = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Follow Ups',
    position: [960, 300],
    executeOnce: true,
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode:
        "// Picks the Contacted leads due their day-2 follow-up text this run. One output item: the plan.\n" +
        "// DRY_RUN = true: texts nobody, changes nothing in the CRM; Telegram lists who it would text (only when that list changes).\n" +
        "const DRY_RUN = false;\n" +
        "const SENDER = '61457978972';      // Aaron mobile (approved own-number sender), so replies go to his phone\n" +
        "const START_DATE = '2026-11-01';   // only leads whose D1 was ticked on or after this Sydney date\n" +
        "const BACKLOG_IDS = [];            // older leads Aaron asked to include (they still get every check below)\n" +
        "const DUE_DAYS = 2;                // D1 on Monday -> texted Wednesday evening\n" +
        "const FROM_HOUR = 17, UNTIL_HOUR = 20;   // Sydney time; outside this nothing is sent\n" +
        "const MAX_PER_RUN = 6;             // spreads a busy day over the evening runs (every 15 min)\n" +
        "const MAX_DUE = 60;                // more due than this at once looks wrong: send nothing, warn\n" +
        "const REPEAT_DAYS = 30;            // never send this text to the same number twice within 30 days\n" +
        "const TEXT = \"Hi {name}, Aaron here from Rapid Oven Cleaning. Just following up as you wanted us to get back in touch. Is it a standard oven, wide oven or BBQ?\";\n" +
        "\n" +
        "const nowMs = Date.now();\n" +
        "const store = $getWorkflowStaticData('global');\n" +
        "store.sentLeads = store.sentLeads || {};\n" +
        "store.sentNumbers = store.sentNumbers || {};\n" +
        "store.skipNoted = store.skipNoted || {};\n" +
        "const keepAfter = nowMs - REPEAT_DAYS * 864e5;\n" +
        "for (const m of [store.sentLeads, store.sentNumbers, store.skipNoted]) for (const k of Object.keys(m)) if (!(m[k] >= keepAfter)) delete m[k];\n" +
        "\n" +
        "// Any failed lookup stops the send: without the opt-out list or the booked jobs we could text the wrong people.\n" +
        "const fetched = {};\n" +
        "const problems = [];\n" +
        "for (const [key, nodeName, label] of [['leads', 'Fetch Recent Leads', 'the CRM leads'], ['jc', 'Fetch Booked Jobs', 'booked jobs'], ['opt', 'Fetch Opt-outs', 'the opt-out list']]) {\n" +
        "  const rows = $(nodeName).all().map(i => i.json || {});\n" +
        "  if (rows.some(r => r.error)) problems.push('could not load ' + label);\n" +
        "  fetched[key] = rows.filter(r => r && !r.error && Object.keys(r).length);\n" +
        "}\n" +
        "\n" +
        "// Sydney calendar date (YYYY-MM-DD) and hour.\n" +
        "const sydParts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })\n" +
        "  .formatToParts(new Date(ms)).map(p => [p.type, p.value]));\n" +
        "const sydDate = ms => { const p = sydParts(ms); return p.year + '-' + p.month + '-' + p.day; };\n" +
        "const sydHour = Number(sydParts(nowMs).hour);\n" +
        "const inWindow = sydHour >= FROM_HOUR && sydHour < UNTIL_HOUR;\n" +
        "const lastDue = sydDate(nowMs - DUE_DAYS * 864e5);   // D1 on or before this date is due\n" +
        "\n" +
        "// MobileMessage drops curly quotes, dashes etc., so send plain characters only.\n" +
        "const plain = s => String(s || '').replace(/[\\u2018\\u2019\\u201B\\u2032]/g, String.fromCharCode(39)).replace(/[\\u201C\\u201D\\u2033]/g, '\"')\n" +
        "  .replace(/[\\u2013\\u2014\\u2212]/g, '-').replace(/\\u2026/g, '...').replace(/\\u00A0/g, ' ');\n" +
        "// Same as Instant Lead Reply: firstNameOf() from index.html, after tidying synced names.\n" +
        "function firstNameOf(name) {\n" +
        "  name = (name || '').trim();\n" +
        "  if (!name) return 'there';\n" +
        "  if (name.includes(',')) { const after = (name.split(',')[1] || '').trim().split(/\\s+/)[0]; if (after) return after; }\n" +
        "  return name.split(/\\s+/)[0] || 'there';\n" +
        "}\n" +
        "function greetName(raw) {\n" +
        "  const tidy = String(raw || '').replace(/#\\s*\\d+/g, ' ').replace(/[^\\p{L}\\s,\\u0027-]/gu, ' ').replace(/\\s+/g, ' ').trim();\n" +
        "  let n = firstNameOf(tidy).replace(/^[^\\p{L}]+|[^\\p{L}]+$/gu, '');\n" +
        "  if (n.length < 2 || /^(unknown|there|test|customer|client|na|nil|none|mr|mrs|ms|miss|dr)$/i.test(n)) return 'there';\n" +
        "  if (n === n.toUpperCase() || n === n.toLowerCase()) n = n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();\n" +
        "  return n;\n" +
        "}\n" +
        "// Phone fields can hold two numbers (\"0412 345 678, 02 9xxx xxxx\"); use the first AU mobile.\n" +
        "function mobileOf(raw) {\n" +
        "  for (const part of String(raw || '').split(/[,;\\/]|\\bor\\b/i)) {\n" +
        "    let d = part.replace(/\\D/g, '');\n" +
        "    if (d.startsWith('0')) d = '61' + d.slice(1);\n" +
        "    else if (d.length === 9 && d.startsWith('4')) d = '61' + d;\n" +
        "    if (/^614\\d{8}$/.test(d)) return d;\n" +
        "  }\n" +
        "  return '';\n" +
        "}\n" +
        "const d1Ms = l => Number(l.d1At || l.autoReplyAt || l.trackedAt) || 0;\n" +
        "\n" +
        "const leads = fetched.leads.filter(r => r.id).map(r => ({ id: String(r.id), ...(r.data || {}) }));\n" +
        "// Booked: the lead itself is in Job Count, or its number has a job in the last 3 weeks or later.\n" +
        "const jobsFrom = sydDate(nowMs - 21 * 864e5);\n" +
        "const bookedIds = new Set(), bookedNums = new Set();\n" +
        "for (const r of fetched.jc) for (const j of (Array.isArray(r.jobs) ? r.jobs : [])) {\n" +
        "  if (!j) continue;\n" +
        "  if (j.leadId) bookedIds.add(j.leadId);\n" +
        "  const n = String(r.date || '') >= jobsFrom && mobileOf(j.phone);\n" +
        "  if (n) bookedNums.add(n);\n" +
        "}\n" +
        "const optOut = new Set(fetched.opt.map(r => r.canonical_number).filter(Boolean));\n" +
        "// Other leads with the same number that say: booked, said no, or already followed up.\n" +
        "const others = new Map();   // number -> [{ id, reason, quiet }]\n" +
        "for (const l of leads) {\n" +
        "  const n = mobileOf(l.phone);\n" +
        "  if (!n) continue;\n" +
        "  const add = (reason, quiet) => { if (!others.has(n)) others.set(n, []); others.get(n).push({ id: l.id, reason, quiet }); };\n" +
        "  const recent = Number(l.createdAt) >= keepAfter;\n" +
        "  if (l.stage === 'won' && recent) add('booked on another lead', true);\n" +
        "  else if (['lost', 'deadlead'].includes(l.stage) && recent) add('marked lost on another lead');\n" +
        "  if (l.d2 && Number(l.d2At) >= keepAfter) add('already followed up on another lead', true);\n" +
        "}\n" +
        "\n" +
        "const backlog = new Set(BACKLOG_IDS);\n" +
        "const messages = [];\n" +
        "const skipped = [];   // newly skipped leads worth a Telegram note\n" +
        "const usedNumbers = new Set();\n" +
        "const due = problems.length ? [] : leads.filter(l => {\n" +
        "  if (!/^sm8_/.test(l.id) || l.archived || l.mergedInto || l.stage !== 'contacted' || !l.d1 || l.d2) return false;\n" +
        "  const ms = d1Ms(l);\n" +
        "  if (!ms) return false;\n" +
        "  const d = sydDate(ms);\n" +
        "  return d <= lastDue && (d >= START_DATE || backlog.has(l.id));\n" +
        "}).sort((a, b) => d1Ms(a) - d1Ms(b));\n" +
        "for (const l of due) {\n" +
        "  const who = l.name || 'Unknown';\n" +
        "  const to = mobileOf(l.phone);\n" +
        "  // Each skipped lead is reported to Telegram once, not every run. Booked / duplicate leads are skipped quietly.\n" +
        "  const skip = (reason, quiet) => { if (!quiet && !DRY_RUN && !store.skipNoted[l.id]) { store.skipNoted[l.id] = nowMs; skipped.push({ id: l.id, who, reason }); } };\n" +
        "  if (l.d2AutoAt || store.sentLeads[l.id]) continue;                // already done, stay quiet\n" +
        "  if (bookedIds.has(l.id) || (to && bookedNums.has(to))) { skip('already booked', true); continue; }\n" +
        "  if (!to) { skip('no AU mobile'); continue; }\n" +
        "  if (optOut.has(to)) { skip('opted out'); continue; }\n" +
        "  if (store.sentNumbers[to] || usedNumbers.has(to)) { skip('number already followed up', true); continue; }\n" +
        "  const other = (others.get(to) || []).find(o => o.id !== l.id);\n" +
        "  if (other) { skip(other.reason, other.quiet); continue; }\n" +
        "  usedNumbers.add(to);\n" +
        "  messages.push({ operation_id: 'd2-' + l.id, leadId: l.id, to, who, d1Date: sydDate(d1Ms(l)), message: plain(TEXT.replace('{name}', greetName(l.name))) });\n" +
        "}\n" +
        "\n" +
        "if (messages.length > MAX_DUE) problems.push(messages.length + ' leads due at once, which looks wrong');\n" +
        "const problem = problems.join('; ');\n" +
        "const send = DRY_RUN || problem || !inWindow ? [] : messages.slice(0, MAX_PER_RUN);\n" +
        "// Claim before sending: if anything after this fails, the lead is never texted twice.\n" +
        "for (const m of send) { store.sentLeads[m.leadId] = nowMs; store.sentNumbers[m.to] = nowMs; }\n" +
        "\n" +
        "// One warning per 2 hours, not every run.\n" +
        "let warn = false;\n" +
        "if (problem && !(store.lastWarnAt > nowMs - 2 * 3600e3)) { store.lastWarnAt = nowMs; warn = true; }\n" +
        "// Dry run: post the would-text list only when it changes.\n" +
        "const wouldText = DRY_RUN ? messages.map(m => m.who + ' ' + m.to + ' (D1 ' + m.d1Date + ')') : [];\n" +
        "let dryNote = false;\n" +
        "if (DRY_RUN && wouldText.join('|') !== store.lastDryList) { store.lastDryList = wouldText.join('|'); dryNote = true; }\n" +
        "\n" +
        "let h = 5381; for (const c of send.map(m => m.operation_id).join(',')) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;\n" +
        "return [{ json: {\n" +
        "  dryRun: DRY_RUN,\n" +
        "  send: send.length > 0,\n" +
        "  problem,\n" +
        "  warn,\n" +
        "  messages: send,\n" +
        "  waiting: Math.max(0, messages.length - send.length),\n" +
        "  skipped,\n" +
        "  wouldText,\n" +
        "  dryNote,\n" +
        "  sample: messages.length ? messages[0].message : '',\n" +
        "  idempotencyKey: 'd2-followup-' + h.toString(36) + '-' + send.length,\n" +
        "  providerPayload: { messages: send.map(m => ({ to: m.to, message: m.message, sender: SENDER, custom_ref: m.operation_id })) },\n" +
        "} }];" },
  },
  output: [{ dryRun: false, send: true, problem: '', warn: false, messages: [{ operation_id: 'd2-sm8_x', leadId: 'sm8_x', to: '61412345678', who: 'Smith, Jane', d1Date: '2026-11-02', message: 'Hi Jane...' }], waiting: 0, skipped: [], wouldText: [], dryNote: false, sample: 'Hi Jane...', idempotencyKey: 'd2-followup-abc-1', providerPayload: { messages: [{ to: '61412345678', message: 'Hi Jane...', sender: '61457978972', custom_ref: 'd2-sm8_x' }] } }],
});

const sendForReal = ifElse({
  version: 2.2,
  config: {
    name: 'Anyone to Text?',
    position: [1200, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: expr('{{ $json.send }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
    },
  },
});

// Never retried: a retry could double-text. Leads are also claimed in workflow static data before this runs.
const sendSms = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Send via MobileMessage',
    position: [1440, 200],
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
  output: [{ status: 'complete', results: [{ to: '61412345678', custom_ref: 'd2-sm8_x', status: 'success', message_id: 'mm_1', cost: 1 }] }],
});

const recordResults = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Record Results',
    position: [1680, 200],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode:
        "// What MobileMessage said for each text, plus the CRM updates for the accepted ones:\n" +
        "// d2AutoAt, D2 ticked (d2At/trackedAt), Contacted -> Follow Up, two history lines (same shapes as toggleFlag()/logAct() in index.html).\n" +
        "const plan = $('Build Follow Ups').first().json;\n" +
        "const res = $input.first().json || {};\n" +
        "let results, note = '';\n" +
        "if (Array.isArray(res.results)) {\n" +
        "  results = res.results.map(r => {\n" +
        "    const s = String(r.status || '').toLowerCase();\n" +
        "    return {\n" +
        "      operation_id: r.custom_ref || '',\n" +
        "      // blocked = the number unsubscribed with MobileMessage, so it was never sent.\n" +
        "      status: ['queued', 'sent', 'accepted', 'success'].includes(s) ? 'accepted' : s === 'blocked' ? 'blocked' : ['failed', 'rejected', 'invalid', 'error'].includes(s) ? 'failed' : 'unknown',\n" +
        "    };\n" +
        "  });\n" +
        "} else {\n" +
        "  // A clear refusal (bad login, no credit, bad request, rate limit) means nothing went out. Anything else might have, so it is unknown.\n" +
        "  const err = res.error || {};\n" +
        "  const code = Number(err.httpCode || err.status || (String(err.message || '').match(/\\b([45]\\d\\d)\\b/) || [])[1] || 0);\n" +
        "  const definite = [400, 401, 402, 403, 429].includes(code);\n" +
        "  results = plan.messages.map(m => ({ operation_id: m.operation_id, status: definite ? 'failed' : 'unknown' }));\n" +
        "  note = definite ? 'MobileMessage refused the request (HTTP ' + code + ').' : 'MobileMessage did not give a clear answer, check it before texting them yourself.';\n" +
        "}\n" +
        "const reported = new Set(results.map(r => r.operation_id));\n" +
        "plan.messages.filter(m => !reported.has(m.operation_id)).forEach(m => results.push({ operation_id: m.operation_id, status: 'unknown' }));\n" +
        "\n" +
        "const leads = new Map($('Fetch Recent Leads').all().map(i => i.json || {}).filter(r => r.id).map(r => [String(r.id), r.data || {}]));\n" +
        "const accepted = new Set(results.filter(r => r.status === 'accepted').map(r => r.operation_id));\n" +
        "const nowMs = Date.now(), nowIso = new Date(nowMs).toISOString();\n" +
        "const upserts = [];\n" +
        "for (const m of plan.messages) {\n" +
        "  const data = m.leadId && leads.get(m.leadId);\n" +
        "  if (plan.dryRun || !accepted.has(m.operation_id) || !data) continue;\n" +
        "  const add = [{ ts: nowMs, text: 'Auto-texted day-2 follow up' }];\n" +
        "  const toFollowUp = data.stage === 'contacted';\n" +
        "  if (toFollowUp) add.push({ ts: nowMs, text: 'Moved to Follow Up (auto day-2 text)' });\n" +
        "  const history = (Array.isArray(data.history) ? data.history : []).concat(add).slice(-60);\n" +
        "  upserts.push({ id: m.leadId, data: { ...data, d2AutoAt: nowMs, d2: true, d2At: nowMs, trackedAt: nowMs, stage: toFollowUp ? 'followup' : data.stage, history }, updated_at: nowIso });\n" +
        "}\n" +
        "return [{ json: { results, note, upserts } }];" },
  },
  output: [{ results: [{ operation_id: 'd2-sm8_x', status: 'accepted' }], note: '', upserts: [{ id: 'sm8_x', data: { name: 'Smith, Jane', stage: 'followup', d2: true }, updated_at: '2026-11-04T06:01:20.000Z' }] }],
});

const markFollowUp = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Mark Follow Up in CRM',
    position: [1920, 200],
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

const buildNotes = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Telegram Notes',
    position: [2160, 300],
    executeOnce: true,
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode:
        "// One Telegram message per lead texted (or not confirmed), one per newly skipped lead, a lookup warning at most every 2 hours,\n" +
        "// and in dry run the would-text list whenever it changes.\n" +
        "const plan = $('Build Follow Ups').first().json;\n" +
        "const rec = $('Record Results').isExecuted ? $('Record Results').first().json : null;\n" +
        "const stamp = $('Mark Follow Up in CRM').isExecuted ? ($('Mark Follow Up in CRM').first().json || {}) : null;\n" +
        "const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\n" +
        "const fmt = n => (n && n.length === 11 ? '0' + n.slice(2, 5) + ' ' + n.slice(5, 8) + ' ' + n.slice(8) : n || '?');\n" +
        "// \"Silva, Fernanda Da\" -> \"Fernanda Da Silva\"; drops the \"#1792...\" the missed-call bot adds.\n" +
        "const nice = n => { n = String(n || '').replace(/#\\s*\\d+/g, '').replace(/\\s+/g, ' ').trim(); const p = n.split(','); return (p.length === 2 && p[1].trim() ? p[1].trim() + ' ' + p[0].trim() : n.replace(/,\\s*$/, '')) || 'Unknown'; };\n" +
        "const label = m => esc(nice(m.who)) + ' ' + fmt(m.to);\n" +
        "const out = [];\n" +
        "if (plan.problem && plan.warn) out.push('⚠️ <b>Day-2 follow up</b> paused: ' + esc(plan.problem) + '. Nothing sent, it will try again next run.');\n" +
        "if (rec) {\n" +
        "  const byOp = new Map(plan.messages.map(m => [m.operation_id, m]));\n" +
        "  for (const r of rec.results) {\n" +
        "    const m = byOp.get(r.operation_id);\n" +
        "    if (!m) continue;\n" +
        "    if (r.status === 'accepted') out.push('📲 Day-2 follow up sent to ' + label(m));\n" +
        "    else if (r.status === 'blocked') out.push('🚫 Day-2 follow up not sent (unsubscribed): ' + label(m));\n" +
        "    else if (r.status === 'failed') out.push('❌ Day-2 follow up failed, text them yourself: ' + label(m) + (rec.note ? '\\n' + esc(rec.note) : ''));\n" +
        "    else out.push('⚠️ Day-2 follow up not confirmed: ' + label(m) + '\\n' + esc(rec.note || 'Check MobileMessage before texting them yourself.'));\n" +
        "  }\n" +
        "  if (rec.upserts.length && stamp && stamp.error) out.push('⚠️ Could not mark the followed-up leads as Follow Up in the CRM.');\n" +
        "}\n" +
        "if (plan.dryRun && plan.dryNote) out.push('🧪 <b>Day-2 follow up (dry run)</b>, nothing sent. Due now: ' + (plan.wouldText.length ? plan.wouldText.length + '\\n' + esc(plan.wouldText.join('\\n')) + '\\n\\nText: ' + esc(plan.sample) : 'none'));\n" +
        "for (const s of plan.skipped) out.push('ℹ️ Day-2 follow up skipped (' + esc(s.reason) + '): ' + esc(nice(s.who)));\n" +
        "return out.map(text => ({ json: { text: text.slice(0, 4000) } }));" },
  },
  output: [{ text: '📲 Day-2 follow up sent to Jane Smith 0412 345 678' }],
});

const telegram = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Telegram Note',
    position: [2400, 300],
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
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
  '## Day-2 follow up (funnel stage 2)\n\n' +
    'Every 15 min, 5-8pm Sydney: Contacted leads with D1 ticked 2+ days ago (Sydney dates; D1 from START_DATE on,\n' +
    'or listed in BACKLOG_IDS) and no D2 get one text from 0457 978 972 (Aaron). Max 6 per run.\n' +
    'Skips: booked (Job Count lead or number), no AU mobile, opted out, number followed up in the last 30 days,\n' +
    'number booked / lost / followed up on another lead. Any failed lookup or 60+ due = nothing sent (Telegram warning).\n' +
    'Sent: D2 ticked, Contacted -> Follow Up, d2AutoAt + history. DRY_RUN at the top of Build Follow Ups.',
  [every15, fetchLeads, fetchBooked, fetchOptOuts, buildFollowUps],
  { color: 5 },
);

export default workflow('rapid-oven-d2-followup', 'Rapid Oven – D2 Follow Up')
  .add(every15)
  .to(fetchLeads)
  .to(fetchBooked)
  .to(fetchOptOuts)
  .to(buildFollowUps)
  .to(
    sendForReal
      .onTrue(sendSms.to(recordResults.to(markFollowUp.to(buildNotes.to(telegram)))))
      .onFalse(buildNotes),
  )
  .add(readme);
