import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

// Rapid Oven – Instant Lead Reply. Every 3 minutes (offset from Lead Sync's runs) texts each new enquiry lead
// (Meta/Brevo/Google/Digitool/Contact Form "new lead (...)" and "[Missed Call/Text]") a quick reply from Aaron's own mobile,
// so customers reply straight to his phone. Accepted texts tick D1, move the lead New -> Contacted and add history lines.
// One Telegram note per lead. Build Replies has TEST_MODE at the top: true = one text to Aaron's own number, no CRM changes.

const every3 = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 3 Minutes',
    position: [0, 300],
    // Minute 1, 4, 7... at :15, so it never overlaps Lead Sync (minute 0, 3, 6... at about :47), which rewrites whole lead rows.
    parameters: { rule: { interval: [{ field: 'cronExpression', expression: '15 1-59/3 * * * *' }] } },
  },
  output: [{ timestamp: '2026-10-26T10:01:15.000+11:00' }],
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
        { name: 'data->>createdAt', value: expr('gte.{{ $now.toMillis() - 30 * 86400000 }}') },
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
  output: [{ id: 'sm8_x', data: { name: 'Smith, Jane', phone: '+61412345678', stage: 'new', service: 'Oven/BBQ clean -- new lead (Meta)', createdAt: 1792972000000 } }],
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
  output: [{ date: '2026-10-26', jobs: [{ time: '08:00', customer: 'Smith, Jane', status: 'Quote', leadId: 'sm8_y' }] }],
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

const buildReplies = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Replies',
    position: [960, 300],
    executeOnce: true,
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: 
        "// Picks the new enquiry leads to auto-text this run. One output item: the plan.\n" +
        "// TEST_MODE = true: sends ONE text (to TEST_TO, as if from a lead called Aaron), changes nothing in the CRM.\n" +
        "const TEST_MODE = false;\n" +
        "const TEST_TO = '61457978972';\n" +
        "const SENDER = '61457978972';   // Aaron's mobile (approved own-number sender), so replies go to his phone\n" +
        "const MAX_AGE_MIN = 120;        // only leads that came in during the last 2 hours\n" +
        "const MIN_AGE_MIN = 2;          // and are at least 2 min old, so the Job Count Tracker has listed any booked job first\n" +
        "const REPEAT_DAYS = 30;         // never auto-text the same number twice within 30 days\n" +
        "const TEXT = \"Hi {name}, Aaron here from Rapid Oven Cleaning. Thanks for your enquiry! Is it a standard oven, wide oven or a BBQ? If BBQ how many burners?\";\n" +
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
        "  if (rows.some(r => r.error)) problems.push(\"couldn't load \" + label);\n" +
        "  fetched[key] = rows.filter(r => r && !r.error && Object.keys(r).length);\n" +
        "}\n" +
        "\n" +
        "// MobileMessage drops curly quotes, dashes etc., so send plain characters only.\n" +
        "const plain = s => String(s || '').replace(/[\\u2018\\u2019\\u201B\\u2032]/g, \"'\").replace(/[\\u201C\\u201D\\u2033]/g, '\"')\n" +
        "  .replace(/[\\u2013\\u2014\\u2212]/g, '-').replace(/\\u2026/g, '...').replace(/\\u00A0/g, ' ');\n" +
        "// Same as firstNameOf() in index.html, after tidying synced names: \"Jane Smith #1792879856419\", \"~Moana Aukuso~,\", \"KATY\".\n" +
        "function firstNameOf(name) {\n" +
        "  name = (name || '').trim();\n" +
        "  if (!name) return 'there';\n" +
        "  if (name.includes(',')) { const after = (name.split(',')[1] || '').trim().split(/\\s+/)[0]; if (after) return after; }\n" +
        "  return name.split(/\\s+/)[0] || 'there';\n" +
        "}\n" +
        "function greetName(raw) {\n" +
        "  const tidy = String(raw || '').replace(/#\\s*\\d+/g, ' ').replace(/[^\\p{L}\\s,'-]/gu, ' ').replace(/\\s+/g, ' ').trim();\n" +
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
        "// Enquiry leads only: \"... -- new lead (Meta)\", \"New lead (Contact Form) - ...\", \"[Missed Call/Text] - ...\". Not \"[Booking Bot]\" or booked jobs.\n" +
        "function channelOf(service) {\n" +
        "  const s = String(service || '');\n" +
        "  if (/\\[booking bot\\]/i.test(s)) return '';\n" +
        "  if (/^\\s*\\[missed call\\/text\\]/i.test(s)) return 'Missed call/text';\n" +
        "  const m = s.match(/new lead \\(([^)]+)\\)/i);\n" +
        "  return m ? m[1].trim() : '';\n" +
        "}\n" +
        "const texted = l => (Array.isArray(l.history) ? l.history : []).some(h => /^texted|auto-texted/i.test(String((h && h.text) || '')));\n" +
        "\n" +
        "const leads = fetched.leads.filter(r => r.id).map(r => ({ id: String(r.id), ...(r.data || {}) }));\n" +
        "const booked = new Set(fetched.jc.flatMap(r => Array.isArray(r.jobs) ? r.jobs : []).map(j => j && j.leadId).filter(Boolean));\n" +
        "const optOut = new Set(fetched.opt.map(r => r.canonical_number).filter(Boolean));\n" +
        "// Numbers we've already been in touch with on another lead (auto reply, a text, D1 ticked or moved past New).\n" +
        "const touched = new Map();\n" +
        "for (const l of leads) {\n" +
        "  const n = mobileOf(l.phone);\n" +
        "  if (!n) continue;\n" +
        "  if (Number(l.autoReplyAt) >= keepAfter || texted(l) || l.d1 || (l.stage && l.stage !== 'new')) touched.set(n, l.id);\n" +
        "}\n" +
        "\n" +
        "const messages = [];\n" +
        "const skipped = [];   // newly skipped leads worth a Telegram note\n" +
        "const usedNumbers = new Set();\n" +
        "const candidates = problems.length ? [] : leads.filter(l => {\n" +
        "  const age = (nowMs - Number(l.createdAt)) / 60000;\n" +
        "  return /^sm8_/.test(l.id) && !l.archived && l.stage === 'new' && age >= MIN_AGE_MIN && age <= MAX_AGE_MIN && channelOf(l.service);\n" +
        "}).sort((a, b) => Number(a.createdAt) - Number(b.createdAt));\n" +
        "for (const l of candidates) {\n" +
        "  const who = l.name || 'Unknown';\n" +
        "  const to = mobileOf(l.phone);\n" +
        "  // Each skipped lead is reported to Telegram once, not every run. Booked / duplicate leads are skipped quietly.\n" +
        "  const skip = (reason, quiet) => { if (!quiet && !store.skipNoted[l.id]) { store.skipNoted[l.id] = nowMs; skipped.push({ id: l.id, who, reason }); } };\n" +
        "  if (l.autoReplyAt || store.sentLeads[l.id]) continue;            // already done, stay quiet\n" +
        "  if (l.d1 || texted(l)) continue;                                   // someone already texted them\n" +
        "  if (booked.has(l.id)) { skip('already booked', true); continue; }\n" +
        "  if (!to) { skip('no AU mobile'); continue; }\n" +
        "  if (optOut.has(to)) { skip('opted out'); continue; }\n" +
        "  if (store.sentNumbers[to] || usedNumbers.has(to)) { skip('number already auto-texted', true); continue; }\n" +
        "  const other = touched.get(to);\n" +
        "  if (other && other !== l.id) { skip('already in touch on another lead'); continue; }\n" +
        "  usedNumbers.add(to);\n" +
        "  messages.push({ operation_id: 'ir-' + l.id, leadId: l.id, to, who, channel: channelOf(l.service), message: plain(TEXT.replace('{name}', greetName(l.name))) });\n" +
        "}\n" +
        "\n" +
        "let send = messages;\n" +
        "if (TEST_MODE) send = [{ operation_id: 'ir-test-' + nowMs, leadId: '', to: TEST_TO, who: 'TEST (Aaron)', channel: 'Test', message: plain(TEXT.replace('{name}', 'Aaron')) }];\n" +
        "// Claim before sending: if anything after this fails, the lead is never texted twice.\n" +
        "if (!TEST_MODE && !problems.length) for (const m of send) { store.sentLeads[m.leadId] = nowMs; store.sentNumbers[m.to] = nowMs; }\n" +
        "\n" +
        "// One \"couldn't load\" warning per 2 hours, not every 3 minutes.\n" +
        "const problem = problems.join('; ');\n" +
        "let warn = false;\n" +
        "if (problem && !(store.lastWarnAt > nowMs - 2 * 3600e3)) { store.lastWarnAt = nowMs; warn = true; }\n" +
        "\n" +
        "let h = 5381; for (const c of send.map(m => m.operation_id).join(',')) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;\n" +
        "return [{ json: {\n" +
        "  testMode: TEST_MODE,\n" +
        "  send: !problem && send.length > 0,\n" +
        "  problem,\n" +
        "  warn,\n" +
        "  messages: send,\n" +
        "  skipped,\n" +
        "  wouldText: TEST_MODE ? messages.map(m => m.who + ' ' + m.to) : [],   // test mode: the real leads it would text right now\n" +
        "  idempotencyKey: 'instant-reply-' + h.toString(36) + '-' + send.length,\n" +
        "  providerPayload: { messages: send.map(m => ({ to: m.to, message: m.message, sender: SENDER, custom_ref: m.operation_id })) },\n" +
        "} }];" },
  },
  output: [{ testMode: false, send: true, problem: '', warn: false, messages: [{ operation_id: 'ir-sm8_x', leadId: 'sm8_x', to: '61412345678', who: 'Smith, Jane', channel: 'Meta', message: 'Hi Jane...' }], skipped: [], idempotencyKey: 'instant-reply-abc-1', providerPayload: { messages: [{ to: '61412345678', message: 'Hi Jane...', sender: '61457978972', custom_ref: 'ir-sm8_x' }] } }],
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
  output: [{ status: 'complete', results: [{ to: '61412345678', custom_ref: 'ir-sm8_x', status: 'success', message_id: 'mm_1', cost: 1 }] }],
});

const recordResults = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Record Results',
    position: [1680, 200],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: 
        "// What MobileMessage said for each text, plus the CRM updates for the accepted ones:\n" +
        "// autoReplyAt, D1 ticked (d1At/trackedAt), New -> Contacted, two history lines (same shapes as toggleFlag()/logAct() in index.html).\n" +
        "const plan = $('Build Replies').first().json;\n" +
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
        "  // A clear refusal (bad login, no credit, bad request, rate limit) means nothing went out. Anything else might have, so it's unknown.\n" +
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
        "  if (plan.testMode || !accepted.has(m.operation_id) || !data) continue;\n" +
        "  const add = [{ ts: nowMs, text: 'Auto-texted new enquiry reply' }];\n" +
        "  const toContacted = data.stage === 'new';\n" +
        "  if (toContacted) add.push({ ts: nowMs, text: 'Moved to Contacted (auto reply)' });\n" +
        "  const history = (Array.isArray(data.history) ? data.history : []).concat(add).slice(-60);\n" +
        "  upserts.push({ id: m.leadId, data: { ...data, autoReplyAt: nowMs, d1: true, d1At: nowMs, trackedAt: nowMs, stage: toContacted ? 'contacted' : data.stage, history }, updated_at: nowIso });\n" +
        "}\n" +
        "return [{ json: { results, note, upserts } }];" },
  },
  output: [{ results: [{ operation_id: 'ir-sm8_x', status: 'accepted' }], note: '', upserts: [{ id: 'sm8_x', data: { name: 'Smith, Jane', stage: 'contacted', autoReplyAt: 1792972000000 }, updated_at: '2026-10-26T00:00:00.000Z' }] }],
});

const markContacted = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Mark Contacted in CRM',
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
        "// One Telegram message per lead texted (or not confirmed), one per newly skipped lead, and a lookup warning at most every 2 hours.\n" +
        "const plan = $('Build Replies').first().json;\n" +
        "const rec = $('Record Results').isExecuted ? $('Record Results').first().json : null;\n" +
        "const stamp = $('Mark Contacted in CRM').isExecuted ? ($('Mark Contacted in CRM').first().json || {}) : null;\n" +
        "const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\n" +
        "const fmt = n => (n && n.length === 11 ? '0' + n.slice(2, 5) + ' ' + n.slice(5, 8) + ' ' + n.slice(8) : n || '?');\n" +
        "// \"Silva, Fernanda Da\" -> \"Fernanda Da Silva\"; drops the \"#1792...\" the missed-call bot adds.\n" +
        "const nice = n => { n = String(n || '').replace(/#\\s*\\d+/g, '').replace(/\\s+/g, ' ').trim(); const p = n.split(','); return (p.length === 2 && p[1].trim() ? p[1].trim() + ' ' + p[0].trim() : n.replace(/,\\s*$/, '')) || 'Unknown'; };\n" +
        "const label = m => esc(m.who) + (m.channel ? ' (' + esc(m.channel) + ')' : '') + ' ' + fmt(m.to);\n" +
        "const out = [];\n" +
        "if (plan.problem && plan.warn) out.push('⚠️ <b>Instant lead reply</b> paused: ' + esc(plan.problem) + '. Nothing sent, it will try again every 3 min.');\n" +
        "if (rec) {\n" +
        "  const byOp = new Map(plan.messages.map(m => [m.operation_id, m]));\n" +
        "  for (const r of rec.results) {\n" +
        "    const m = byOp.get(r.operation_id);\n" +
        "    if (!m) continue;\n" +
        "    if (r.status === 'accepted') out.push((plan.testMode ? '🧪 TEST sent to ' : '📲 Sent to ') + esc(nice(m.who)) + ', ' + fmt(m.to));\n" +
        "    else if (r.status === 'blocked') out.push('🚫 Not auto-replied (unsubscribed): ' + label(m));\n" +
        "    else if (r.status === 'failed') out.push('❌ Auto-reply failed, text them yourself: ' + label(m) + (rec.note ? '\\n' + esc(rec.note) : ''));\n" +
        "    else out.push('⚠️ Auto-reply not confirmed: ' + label(m) + '\\n' + esc(rec.note || 'Check MobileMessage before texting them yourself.'));\n" +
        "  }\n" +
        "  if (rec.upserts.length && stamp && stamp.error) out.push(\"⚠️ Couldn't mark the auto-replied leads as Contacted in the CRM.\");\n" +
        "}\n" +
        "if (plan.testMode) out.push('🧪 Test only. Real leads it would auto-reply right now: ' + (plan.wouldText.length ? esc(plan.wouldText.join(', ')) : 'none'));\n" +
        "for (const s of plan.skipped) out.push('ℹ️ New lead not auto-replied (' + esc(s.reason) + '): ' + esc(s.who));\n" +
        "return out.map(text => ({ json: { text: text.slice(0, 4000) } }));" },
  },
  output: [{ text: 'Auto-replied to Smith, Jane (Meta) 0412 345 678' }],
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
  '## Instant lead reply\n\n' +
    'Every 3 min: new enquiry leads (stage New, 2 min to 2 h old, "new lead (...)" or "[Missed Call/Text]",\n' +
    'not [Booking Bot], not already booked in Job Count) get one text from 0457 978 972 (Aaron).\n' +
    'Skips: no AU mobile, opted out, already texted / D1 ticked, number already in touch on another lead,\n' +
    'number auto-texted in the last 30 days. Any failed lookup = nothing sent (Telegram warning every 2 h).\n' +
    'Sent: D1 ticked, New -> Contacted, autoReplyAt + history. TEST_MODE at the top of Build Replies.',
  [every3, fetchLeads, fetchBooked, fetchOptOuts, buildReplies],
  { color: 5 },
);

export default workflow('rapid-oven-instant-lead-reply', 'Rapid Oven – Instant Lead Reply')
  .add(every3)
  .to(fetchLeads)
  .to(fetchBooked)
  .to(fetchOptOuts)
  .to(buildReplies)
  .to(
    sendForReal
      .onTrue(sendSms.to(recordResults.to(markContacted.to(buildNotes.to(telegram)))))
      .onFalse(buildNotes),
  )
  .add(readme);
