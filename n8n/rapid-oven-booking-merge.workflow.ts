import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

// Rapid Oven – Booking Merge. Every 3 minutes (offset from Lead Sync and the Instant Lead Reply) finds booked jobs
// (any lead booked in Job Count, plus "[Booking Bot]" and "Customer booked ... online" leads) that are the same customer as a
// Contacted enquiry with the same AU mobile, and merges them: the booking keeps its address, gets the
// enquiry's history/tick boxes and moves to Closed — Won; the enquiry is archived (never deleted) with mergedInto.
// Nothing else is touched. Build Merges has DRY_RUN at the top: true = Telegram "would merge" notes only, no CRM changes.

const every3 = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 3 Minutes',
    position: [0, 300],
    // Minute 2, 5, 8... at :15. Lead Sync runs at minute 0, 3, 6... (about :47) and the Instant Lead Reply at minute 1, 4, 7... (:15),
    // both rewrite whole lead rows, so this never overlaps either.
    parameters: { rule: { interval: [{ field: 'cronExpression', expression: '15 2-59/3 * * * *' }] } },
  },
  output: [{ timestamp: '2026-10-26T10:02:15.000+11:00' }],
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
        // 7 days of bookings + 30 days of enquiries before them, plus a day of slack.
        { name: 'data->>createdAt', value: expr('gte.{{ $now.toMillis() - 38 * 86400000 }}') },
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
  output: [{ id: 'sm8_x', data: { name: 'Primmer, Gai', phone: '+61417400585', stage: 'contacted', service: 'Oven/BBQ clean -- new lead (Meta)', createdAt: 1792925151308 } }],
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
      queryParameters: { parameters: [
        { name: 'select', value: 'date,jobs' },
        { name: 'date', value: expr("gte.{{ $now.minus({ days: 10 }).toFormat('yyyy-MM-dd') }}") },
      ] },
      options: {},
    },
    credentials: { httpCustomAuth: { id: '8XVsZkDXlvSmJXhN', name: 'Custom Auth account' } },
  },
  output: [{ date: '2026-10-27', jobs: [{ time: '08:00', customer: 'Steve Primmer', status: 'Work Order', leadId: 'sm8_y' }] }],
});

const buildMerges = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Merges',
    position: [720, 300],
    executeOnce: true,
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: 
        "// Finds booked jobs with the same AU mobile as a Contacted enquiry, and plans the merge. One output item: the plan.\n" +
        "// DRY_RUN = true: changes nothing in the CRM, just a Telegram \"would merge\" note per pair (once each).\n" +
        "const DRY_RUN = false;\n" +
        "const BOOKING_DAYS = 7;        // bookings that came in during the last 7 days\n" +
        "const ENQUIRY_DAYS = 30;       // enquiries from up to 30 days before the booking\n" +
        "const ENQUIRY_AFTER_H = 24;    // ...or up to a day after it (booked before the Meta lead synced)\n" +
        "const MAX_MERGES = 20;         // more than this in one run looks wrong: merge nothing, warn\n" +
        "\n" +
        "const nowMs = Date.now();\n" +
        "const store = $getWorkflowStaticData('global');\n" +
        "store.dryNoted = store.dryNoted || {};\n" +
        "for (const k of Object.keys(store.dryNoted)) if (!(store.dryNoted[k] >= nowMs - 30 * 864e5)) delete store.dryNoted[k];\n" +
        "\n" +
        "// Any failed lookup stops the run: without the booked jobs we can't tell bookings from enquiries.\n" +
        "const fetched = {};\n" +
        "const problems = [];\n" +
        "for (const [key, nodeName, label] of [['leads', 'Fetch Recent Leads', 'the CRM leads'], ['jc', 'Fetch Booked Jobs', 'booked jobs']]) {\n" +
        "  const rows = $(nodeName).all().map(i => i.json || {});\n" +
        "  if (rows.some(r => r.error)) problems.push(\"couldn't load \" + label);\n" +
        "  fetched[key] = rows.filter(r => r && !r.error && Object.keys(r).length);\n" +
        "}\n" +
        "if (!problems.length && !fetched.leads.length) problems.push('no CRM leads came back');\n" +
        "\n" +
        "// Same as mobileOf() in the Instant Lead Reply: first AU mobile in the field, as 614XXXXXXXX.\n" +
        "function mobileOf(raw) {\n" +
        "  for (const part of String(raw || '').split(/[,;\\/]|\\bor\\b/i)) {\n" +
        "    let d = part.replace(/\\D/g, '');\n" +
        "    if (d.startsWith('0')) d = '61' + d.slice(1);\n" +
        "    else if (d.length === 9 && d.startsWith('4')) d = '61' + d;\n" +
        "    if (/^614\\d{8}$/.test(d)) return d;\n" +
        "  }\n" +
        "  return '';\n" +
        "}\n" +
        "// Enquiry channel for the history line, like leadSource() in index.html.\n" +
        "function channelOf(service) {\n" +
        "  const s = String(service || '');\n" +
        "  if (/^\\s*\\[missed call\\/text\\]/i.test(s)) return 'Missed call/text';\n" +
        "  const m = s.match(/new lead \\(([^)]+)\\)/i);\n" +
        "  return m ? m[1].trim() : '';\n" +
        "}\n" +
        "const bookingShaped = l => /^\\s*\\[booking bot\\]/i.test(l.service || '') || /customer booked .* online/i.test(l.service || '');\n" +
        "const day = ms => { try { return new Date(Number(ms)).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short' }); } catch (e) { return new Date(Number(ms)).toISOString().slice(0, 10); } };\n" +
        "const nice = n => { n = String(n || '').replace(/#\\s*\\d+/g, '').replace(/\\s+/g, ' ').trim(); const p = n.split(','); return (p.length === 2 && p[1].trim() ? p[1].trim() + ' ' + p[0].trim() : n.replace(/,\\s*$/, '')) || 'Unknown'; };\n" +
        "const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;\n" +
        "const NL = String.fromCharCode(10);\n" +
        "\n" +
        "const leads = fetched.leads.filter(r => r.id && SAFE_ID.test(String(r.id))).map(r => ({ id: String(r.id), ...(r.data || {}) }));\n" +
        "const booked = new Set(fetched.jc.flatMap(r => Array.isArray(r.jobs) ? r.jobs : []).map(j => j && j.leadId).filter(Boolean));\n" +
        "const isBooking = l => booked.has(l.id) || bookingShaped(l);\n" +
        "\n" +
        "const bookings = leads.filter(l => /^sm8_/.test(l.id) && !l.archived && isBooking(l) && !['lost', 'deadlead'].includes(l.stage)\n" +
        "  && Number(l.createdAt) >= nowMs - BOOKING_DAYS * 864e5).sort((a, b) => Number(a.createdAt) - Number(b.createdAt));\n" +
        "const enquiries = leads.filter(l => l.stage === 'contacted' && !l.archived && !l.mergedInto && !isBooking(l));\n" +
        "\n" +
        "const pairs = [];   // { booking, enqs: [{ lead, how }] }\n" +
        "const used = new Set();\n" +
        "if (!problems.length) for (const b of bookings) {\n" +
        "  const bMob = mobileOf(b.phone), bAt = Number(b.createdAt);\n" +
        "  if (!bMob) continue;   // only the same mobile counts as the same customer\n" +
        "  const enqs = [];\n" +
        "  for (const e of enquiries) {\n" +
        "    if (used.has(e.id) || e.id === b.id) continue;\n" +
        "    const eAt = Number(e.createdAt);\n" +
        "    if (!(eAt >= bAt - ENQUIRY_DAYS * 864e5 && eAt <= bAt + ENQUIRY_AFTER_H * 3600e3)) continue;\n" +
        "    if (mobileOf(e.phone) === bMob) enqs.push({ lead: e, how: 'mobile' });\n" +
        "  }\n" +
        "  if (!enqs.length) continue;\n" +
        "  enqs.forEach(x => used.add(x.lead.id));\n" +
        "  pairs.push({ booking: b, enqs: enqs.sort((x, y) => Number(x.lead.createdAt) - Number(y.lead.createdAt)) });\n" +
        "}\n" +
        "\n" +
        "const nowIso = new Date(nowMs).toISOString();\n" +
        "const upserts = [];\n" +
        "const merges = [];\n" +
        "for (const { booking: b, enqs } of pairs) {\n" +
        "  const data = { ...b };\n" +
        "  const add = [];\n" +
        "  for (const { lead: e } of enqs) {\n" +
        "    const ch = channelOf(e.service);\n" +
        "    add.push({ ts: nowMs, text: 'Merged with ' + (ch ? ch + ' ' : '') + 'enquiry from ' + day(e.createdAt) + (nice(e.name) !== nice(b.name) ? ' (' + nice(e.name) + ')' : '') });\n" +
        "    // Tick boxes, auto-reply and review stamps carry over, so nothing re-texts this customer.\n" +
        "    for (const k of ['d1', 'd2', 'd3', 'called']) if (e[k] && !data[k]) { data[k] = true; if (e[k + 'At']) data[k + 'At'] = e[k + 'At']; }\n" +
        "    for (const k of ['autoReplyAt', 'reviewSentAt', 'trackedAt']) if (Number(e[k]) > (Number(data[k]) || 0)) data[k] = e[k];\n" +
        "    if (!data.email && e.email) data.email = e.email;\n" +
        "    const en = String(e.notes || '').trim();\n" +
        "    if (en && en !== String(e.service || '').trim() && !String(data.notes || '').includes(en)) data.notes = (String(data.notes || '').trim() + NL + NL + 'Enquiry (' + (ch || 'earlier') + ', ' + day(e.createdAt) + '): ' + en).trim();\n" +
        "  }\n" +
        "  if (data.stage !== 'won') add.push({ ts: nowMs, text: 'Moved to Closed — Won (booked)' });\n" +
        "  data.stage = 'won';\n" +
        "  data.mergedFrom = [].concat(data.mergedFrom || [], enqs.map(x => x.lead.id));\n" +
        "  const hist = [].concat(Array.isArray(b.history) ? b.history : [], ...enqs.map(x => Array.isArray(x.lead.history) ? x.lead.history : []))\n" +
        "    .filter(h => h && h.ts).sort((x, y) => Number(x.ts) - Number(y.ts));\n" +
        "  data.history = hist.concat(add).slice(-60);\n" +
        "  upserts.push({ id: b.id, data, updated_at: nowIso });\n" +
        "  for (const { lead: e } of enqs) {\n" +
        "    const ed = { ...e };\n" +
        "    ed.archived = true;\n" +
        "    ed.mergedInto = b.id;\n" +
        "    ed.history = (Array.isArray(e.history) ? e.history : []).concat([{ ts: nowMs, text: 'Merged into booking ' + nice(b.name) + ' (' + day(b.createdAt) + '), archived' }]).slice(-60);\n" +
        "    upserts.push({ id: e.id, data: ed, updated_at: nowIso });\n" +
        "  }\n" +
        "  merges.push({\n" +
        "    key: b.id + '>' + enqs.map(x => x.lead.id).join('+'),\n" +
        "    booking: { id: b.id, name: nice(b.name), to: mobileOf(b.phone) || String(b.phone || ''), service: String(b.service || '').trim().slice(0, 80), wasStage: b.stage || 'new' },\n" +
        "    enquiries: enqs.map(x => ({ id: x.lead.id, name: nice(x.lead.name), channel: channelOf(x.lead.service) || 'enquiry', on: day(x.lead.createdAt), how: x.how })),\n" +
        "  });\n" +
        "}\n" +
        "\n" +
        "if (merges.length > MAX_MERGES) problems.push(merges.length + ' merges in one run (limit ' + MAX_MERGES + '), check before letting it run');\n" +
        "const problem = problems.join('; ');\n" +
        "let warn = false;\n" +
        "if (problem && !(store.lastWarnAt > nowMs - 2 * 3600e3)) { store.lastWarnAt = nowMs; warn = true; }\n" +
        "const write = !DRY_RUN && !problem && upserts.length > 0;\n" +
        "\n" +
        "// Dry run: report each pair once, not every 3 minutes.\n" +
        "const report = DRY_RUN ? merges.filter(m => !store.dryNoted[m.key]) : merges;\n" +
        "if (DRY_RUN) for (const m of report) store.dryNoted[m.key] = nowMs;\n" +
        "\n" +
        "// A dry run still lists every pair when over MAX_MERGES (merges is empty anyway if a lookup failed).\n" +
        "return [{ json: { dryRun: DRY_RUN, write, problem, warn, merges: problem ? [] : merges, report: DRY_RUN ? report : [], upserts: write ? upserts : [], plannedRows: upserts.length } }];" },
  },
  output: [{ dryRun: true, write: false, problem: '', warn: false, merges: [{ key: 'sm8_y>sm8_x', booking: { id: 'sm8_y', name: 'Steve Primmer', to: '61417400585', service: '[Booking Bot]', wasStage: 'won' }, enquiries: [{ id: 'sm8_x', name: 'Gai Primmer', channel: 'Meta', on: '26 Oct', how: 'mobile' }] }], report: [], upserts: [], plannedRows: 2 }],
});

const anyToWrite = ifElse({
  version: 2.2,
  config: {
    name: 'Anything to Merge?',
    position: [960, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: expr('{{ $json.write }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
    },
  },
});

// One request = one database statement, so the booking and its archived enquiry are saved together or not at all.
const saveMerges = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Save Merges',
    position: [1200, 200],
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
    position: [1440, 300],
    executeOnce: true,
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: 
        "// One Telegram message per merge (or \"would merge\" in a dry run), plus a warning at most every 2 hours.\n" +
        "const plan = $('Build Merges').first().json;\n" +
        "const saved = $('Save Merges').isExecuted ? ($('Save Merges').first().json || {}) : null;\n" +
        "const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\n" +
        "const fmt = n => (/^614\\d{8}$/.test(n) ? '0' + n.slice(2, 5) + ' ' + n.slice(5, 8) + ' ' + n.slice(8) : n || 'no number');\n" +
        "const enqText = m => m.enquiries.map(e => esc(e.name) + ' (' + esc(e.channel) + ', ' + esc(e.on) + (e.how === 'name' ? ', same name only' : '') + ')').join(' + ');\n" +
        "const out = [];\n" +
        "if (plan.problem && plan.warn) out.push('⚠️ <b>Booking merge</b> paused: ' + esc(plan.problem) + '. Nothing merged, it will try again every 3 min.');\n" +
        "if (plan.dryRun) {\n" +
        "  for (const m of plan.report) out.push('🧪 Would merge ' + enqText(m) + ' into booking <b>' + esc(m.booking.name) + '</b>, ' + fmt(m.booking.to) + (m.booking.wasStage !== 'won' ? ', and move it to Won' : ''));\n" +
        "} else if (plan.write) {\n" +
        "  if (saved && saved.error) {\n" +
        "    // One warning per 2 hours, not every 3 minutes.\n" +
        "    const store = $getWorkflowStaticData('global');\n" +
        "    if (!(store.lastSaveWarnAt > Date.now() - 2 * 3600e3)) { store.lastSaveWarnAt = Date.now(); out.push(\"⚠️ <b>Booking merge</b>: couldn't save \" + plan.merges.length + ' merge(s) (' + plan.merges.map(m => esc(m.booking.name)).join(', ') + '). It will keep trying every 3 min.'); }\n" +
        "  }\n" +
        "  else for (const m of plan.merges) out.push('🔗 Booked &amp; merged: <b>' + esc(m.booking.name) + '</b>, ' + fmt(m.booking.to) + ' + ' + enqText(m) + (m.booking.wasStage !== 'won' ? ', moved to Won' : ''));\n" +
        "}\n" +
        "return out.map(text => ({ json: { text: text.slice(0, 4000) } }));" },
  },
  output: [{ text: '🔗 Booked & merged: Steve Primmer, 0417 400 585 + Gai Primmer (Meta, 26 Oct)' }],
});

const telegram = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Telegram Note',
    position: [1680, 300],
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
  '## Booking merge\n\n' +
    'Every 3 min: a booked job (booked in Job Count, [Booking Bot] or "Customer booked ... online", last 7 days, not Lost)\n' +
    'with the same AU mobile as a Contacted enquiry (up to 30 days older) is merged:\n' +
    'booking -> Closed — Won with the enquiry history, tick boxes, email, notes and mergedFrom;\n' +
    'enquiry -> archived + mergedInto (never deleted). Only Contacted enquiries, nothing else is touched.\n' +
    'Any failed lookup or more than 20 merges at once = nothing merged. DRY_RUN at the top of Build Merges.',
  [every3, fetchLeads, fetchBooked, buildMerges],
  { color: 5 },
);

export default workflow('rapid-oven-booking-merge', 'Rapid Oven – Booking Merge')
  .add(every3)
  .to(fetchLeads)
  .to(fetchBooked)
  .to(buildMerges)
  .to(
    anyToWrite
      .onTrue(saveMerges.to(buildNotes.to(telegram)))
      .onFalse(buildNotes),
  )
  .add(readme);
