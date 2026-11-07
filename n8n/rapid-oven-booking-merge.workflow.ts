import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

// Rapid Oven – Booking Merge. Every 3 minutes (offset from Lead Sync and the Instant Lead Reply) finds booked jobs
// (any lead booked in Job Count, plus "[Booking Bot]" and "Customer booked ... online" leads) that are the same customer as a
// Contacted or Follow Up enquiry with the same AU mobile, and merges them: the booking keeps its address, gets the
// enquiry's history/tick boxes and moves to Closed — Won; the enquiry is archived (never deleted) with mergedInto.
// Then (since 7 Nov 2026) every other open pipeline lead whose customer has a Job Count job from today on (the job's own lead or the
// same AU mobile) moves to Closed — Won. Build Merges has DRY_RUN (merges) and MOVE_DRY_RUN (Won moves) at the top: true = Telegram notes only.

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

const fetchPipeline = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Pipeline Leads',
    position: [720, 300],
    executeOnce: true,
    ...fetchOpts,
    parameters: {
      url: 'https://haarvltpfcbixqbwkxpl.supabase.co/rest/v1/leads',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendQuery: true,
      // Every open pipeline lead, any age, slim: the booked -> Won check only needs stage, number and name.
      queryParameters: { parameters: [
        { name: 'select', value: 'id,stage:data->>stage,phone:data->>phone,name:data->>name' },
        { name: 'data->>stage', value: 'in.(new,contacted,followup,deadlead,lost)' },
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
  output: [{ id: 'sm8_x', stage: 'new', phone: '0412345678', name: 'Dawson, Jackie' }],
});

const buildMerges = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Merges',
    position: [960, 300],
    executeOnce: true,
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: 
        "// Finds booked jobs with the same AU mobile as a Contacted or Follow Up enquiry, and plans the merge. One output item: the plan.\n" +
        "// Then moves every other open pipeline lead whose customer is booked in Job Count from today on to Closed — Won.\n" +
        "// DRY_RUN = true: changes nothing in the CRM, just a Telegram \"would merge\" note per pair (once each).\n" +
        "const DRY_RUN = false;\n" +
        "// MOVE_DRY_RUN = true: no Won moves, just a Telegram \"would move\" list whenever it changes.\n" +
        "const MOVE_DRY_RUN = false;\n" +
        "const MOVE_STAGES = ['new', 'contacted', 'followup', 'deadlead', 'lost'];\n" +
        "const MAX_MOVES = 60;          // more Won moves than this in one run looks wrong: move nothing, warn\n" +
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
        "// Follow Up too: the D2 Follow Up workflow moves texted enquiries there.\n" +
        "const enquiries = leads.filter(l => ['contacted', 'followup'].includes(l.stage) && !l.archived && !l.mergedInto && !isBooking(l));\n" +
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
        "    for (const k of ['autoReplyAt', 'd2AutoAt', 'reviewSentAt', 'trackedAt']) if (Number(e[k]) > (Number(data[k]) || 0)) data[k] = e[k];\n" +
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
        "// Booked -> Won: open pipeline leads (any age, from Fetch Pipeline Leads) whose customer has a Job Count job from today on.\n" +
        "// Same customer = the job's own lead, or the same AU mobile (the job's number or its lead's number). Merged leads are left to the merge.\n" +
        "const sydToday = (() => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' })\n" +
        "  .formatToParts(new Date(nowMs)).map(x => [x.type, x.value])); return p.year + '-' + p.month + '-' + p.day; })();\n" +
        "const pipeRows = $('Fetch Pipeline Leads').all().map(i => i.json || {});\n" +
        "const moveProblems = [];   // reasons to move nothing this run (a failed merge lookup already warns on its own)\n" +
        "if (pipeRows.some(r => r.error)) moveProblems.push('could not load the pipeline leads');\n" +
        "const pipe = pipeRows.filter(r => r && r.id && !r.error && SAFE_ID.test(String(r.id)));\n" +
        "if (!moveProblems.length && !pipe.length) moveProblems.push('no pipeline leads came back');\n" +
        "const phoneById = new Map(pipe.map(r => [String(r.id), r.phone]));\n" +
        "for (const l of leads) if (!phoneById.has(l.id)) phoneById.set(l.id, l.phone);\n" +
        "const upcoming = new Map();   // 'id:<lead id>' or mobile -> earliest job from today on\n" +
        "const keep = (k, j, date) => { if (k && !upcoming.has(k)) upcoming.set(k, { date, time: j.time || '' }); };\n" +
        "for (const r of [...fetched.jc].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))) {\n" +
        "  if (!(String(r.date || '') >= sydToday)) continue;\n" +
        "  const jobs = (Array.isArray(r.jobs) ? r.jobs : []).filter(Boolean).sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));\n" +
        "  for (const j of jobs) {\n" +
        "    if (j.leadId) keep('id:' + j.leadId, j, r.date);\n" +
        "    keep(mobileOf(j.phone), j, r.date);\n" +
        "    if (j.leadId) keep(mobileOf(phoneById.get(j.leadId)), j, r.date);\n" +
        "  }\n" +
        "}\n" +
        "const mergedIds = new Set([...used, ...pairs.map(x => x.booking.id)]);\n" +
        "let moves = problem || moveProblems.length ? [] : pipe.filter(r => MOVE_STAGES.includes(r.stage) && !mergedIds.has(String(r.id))).map(r => {\n" +
        "  const byId = upcoming.get('id:' + r.id), job = byId || upcoming.get(mobileOf(r.phone));\n" +
        "  return job ? { id: String(r.id), name: nice(r.name), to: mobileOf(r.phone) || String(r.phone || ''), wasStage: r.stage, job, how: byId ? 'job' : 'mobile' } : null;\n" +
        "}).filter(Boolean).sort((a, b) => (a.job.date + a.job.time).localeCompare(b.job.date + b.job.time));\n" +
        "// Live only: a dry run lists everything, however many.\n" +
        "if (!MOVE_DRY_RUN && moves.length > MAX_MOVES) { moveProblems.push(moves.length + ' leads to move to Won in one run (limit ' + MAX_MOVES + '), check before letting it run'); moves = []; }\n" +
        "const moveProblem = moveProblems.join('; ');\n" +
        "let moveWarn = false;\n" +
        "if (moveProblem && !(store.lastMoveWarnAt > nowMs - 2 * 3600e3)) { store.lastMoveWarnAt = nowMs; moveWarn = true; }\n" +
        "const doMoves = !MOVE_DRY_RUN && !problem && !moveProblem && moves.length > 0;\n" +
        "// Dry run: post the would-move list only when it changes.\n" +
        "let moveReport = false;\n" +
        "if (MOVE_DRY_RUN && !problem && !moveProblem) { const k = moves.map(m => m.id).join(','); if (k !== store.lastMoveList) { store.lastMoveList = k; moveReport = true; } }\n" +
        "\n" +
        "// Dry run: report each pair once, not every 3 minutes.\n" +
        "const report = DRY_RUN ? merges.filter(m => !store.dryNoted[m.key]) : merges;\n" +
        "if (DRY_RUN) for (const m of report) store.dryNoted[m.key] = nowMs;\n" +
        "\n" +
        "// A dry run still lists every pair when over MAX_MERGES (merges is empty anyway if a lookup failed).\n" +
        "return [{ json: { dryRun: DRY_RUN, write, problem, warn, merges: problem ? [] : merges, report: DRY_RUN ? report : [], upserts: write ? upserts : [], plannedRows: upserts.length,\n" +
        "  moveDryRun: MOVE_DRY_RUN, moves, moveIds: doMoves ? moves.map(m => m.id) : [], moveProblem, moveWarn, moveReport } }];"},
  },
  output: [{ dryRun: true, write: false, problem: '', warn: false, merges: [{ key: 'sm8_y>sm8_x', booking: { id: 'sm8_y', name: 'Steve Primmer', to: '61417400585', service: '[Booking Bot]', wasStage: 'won' }, enquiries: [{ id: 'sm8_x', name: 'Gai Primmer', channel: 'Meta', on: '26 Oct', how: 'mobile' }] }], report: [], upserts: [], plannedRows: 2 }],
});


// Fresh full rows for the leads being moved to Won, read just before the write.
const fetchMoveRows = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fetch Move Rows',
    position: [1200, 300],
    executeOnce: true,
    ...fetchOpts,
    parameters: {
      url: 'https://haarvltpfcbixqbwkxpl.supabase.co/rest/v1/leads',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      sendQuery: true,
      queryParameters: { parameters: [
        { name: 'select', value: 'id,data' },
        { name: 'id', value: expr("{{ 'in.(' + (($json.moveIds || []).length ? $json.moveIds.join(',') : 'none') + ')' }}") },
      ] },
      options: {},
    },
    credentials: { httpCustomAuth: { id: '8XVsZkDXlvSmJXhN', name: 'Custom Auth account' } },
  },
  output: [{ id: 'sm8_x', data: { name: 'Dawson, Jackie', stage: 'new' } }],
});

const buildMoves = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Moves',
    position: [1440, 300],
    executeOnce: true,
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: 
        "// Builds the Won moves from fresh copies of the leads, then everything Save Merges writes (merges + moves) in one request.\n" +
        "const plan = $('Build Merges').first().json;\n" +
        "const rows = $('Fetch Move Rows').all().map(i => i.json || {});\n" +
        "const failed = plan.moveIds.length > 0 && rows.some(r => r.error);\n" +
        "const want = new Map(plan.moves.map(m => [m.id, m]));\n" +
        "const STAGES = ['new', 'contacted', 'followup', 'deadlead', 'lost'];\n" +
        "const nowMs = Date.now(), nowIso = new Date(nowMs).toISOString();\n" +
        "const moved = [], upserts = [];\n" +
        "if (plan.moveIds.length && !failed) for (const r of rows) {\n" +
        "  const m = r.id && plan.moveIds.includes(String(r.id)) && want.get(String(r.id));\n" +
        "  const d = r.data || {};\n" +
        "  if (!m || d.archived || d.mergedInto || !STAGES.includes(d.stage)) continue;   // changed since the list was read\n" +
        "  const history = (Array.isArray(d.history) ? d.history : []).concat([{ ts: nowMs, text: 'Moved to Closed — Won (booked in Job Count)' }]).slice(-60);\n" +
        "  upserts.push({ id: String(r.id), data: { ...d, stage: 'won', bookedWonAt: nowMs, history }, updated_at: nowIso });\n" +
        "  moved.push(m);\n" +
        "}\n" +
        "const all = (plan.write ? plan.upserts : []).concat(upserts);\n" +
        "return [{ json: { write: all.length > 0, upserts: all, moved, moveFailed: failed } }];\n" },
  },
  output: [{ write: true, upserts: [{ id: 'sm8_x', data: { name: 'Dawson, Jackie', stage: 'won' }, updated_at: '2026-11-07T09:00:00.000Z' }], moved: [], moveFailed: false }],
});

const anyToWrite = ifElse({
  version: 2.2,
  config: {
    name: 'Anything to Merge?',
    position: [1680, 300],
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
        "// One Telegram message per merge (or \"would merge\" in a dry run), one list of leads moved to Won (or \"would move\"), plus warnings at most every 2 hours.\n" +
        "const plan = $('Build Merges').first().json;\n" +
        "const fin = $('Build Moves').first().json;\n" +
        "const saved = $('Save Merges').isExecuted ? ($('Save Merges').first().json || {}) : null;\n" +
        "const saveFailed = !!(fin.write && saved && saved.error);\n" +
        "const store = $getWorkflowStaticData('global');\n" +
        "const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\n" +
        "const fmt = n => (/^614\\d{8}$/.test(n) ? '0' + n.slice(2, 5) + ' ' + n.slice(5, 8) + ' ' + n.slice(8) : n || 'no number');\n" +
        "const enqText = m => m.enquiries.map(e => esc(e.name) + ' (' + esc(e.channel) + ', ' + esc(e.on) + (e.how === 'name' ? ', same name only' : '') + ')').join(' + ');\n" +
        "const STAGE = { new: 'New', contacted: 'Contacted', followup: 'Follow Up', deadlead: 'Lost Lead', lost: 'Closed — Lost' };\n" +
        "const t12 = t => { const m = String(t || '').match(/^(\\d{1,2}):(\\d{2})/); if (!m) return ''; let h = +m[1]; const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return ' ' + h + (m[2] === '00' ? '' : ':' + m[2]) + ap; };\n" +
        "const when = j => { let d = j.date; try { d = new Date(j.date + 'T12:00:00Z').toLocaleDateString('en-AU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }); } catch (e) {} return d + t12(j.time); };\n" +
        "const line = m => esc(m.name) + ' (' + esc(STAGE[m.wasStage] || m.wasStage) + '), ' + fmt(m.to) + ', job ' + esc(when(m.job)) + (m.how === 'mobile' ? ', same mobile' : '');\n" +
        "const out = [];\n" +
        "// Long lists are split so each Telegram message stays under its 4096-character limit.\n" +
        "const chunked = (head, lines) => { let cur = head; for (const l of lines) { if ((cur + '\\n' + l).length > 3800) { out.push(cur); cur = head + ' (cont.)'; } cur += '\\n' + l; } out.push(cur); };\n" +
        "if (plan.problem && plan.warn) out.push('⚠️ <b>Booking merge</b> paused: ' + esc(plan.problem) + '. Nothing merged, it will try again every 3 min.');\n" +
        "if (plan.moveProblem && plan.moveWarn) out.push('⚠️ <b>Booked → Won</b> paused: ' + esc(plan.moveProblem) + '. Nothing moved, it will try again every 3 min.');\n" +
        "if (plan.dryRun) {\n" +
        "  for (const m of plan.report) out.push('🧪 Would merge ' + enqText(m) + ' into booking <b>' + esc(m.booking.name) + '</b>, ' + fmt(m.booking.to) + (m.booking.wasStage !== 'won' ? ', and move it to Won' : ''));\n" +
        "} else if (plan.write && !saveFailed) {\n" +
        "  for (const m of plan.merges) out.push('🔗 Booked &amp; merged: <b>' + esc(m.booking.name) + '</b>, ' + fmt(m.booking.to) + ' + ' + enqText(m) + (m.booking.wasStage !== 'won' ? ', moved to Won' : ''));\n" +
        "}\n" +
        "if (saveFailed && !(store.lastSaveWarnAt > Date.now() - 2 * 3600e3)) {\n" +
        "  store.lastSaveWarnAt = Date.now();\n" +
        "  const what = [plan.write ? plan.merges.length + ' merge(s) (' + plan.merges.map(m => esc(m.booking.name)).join(', ') + ')' : '', fin.moved.length ? fin.moved.length + ' move(s) to Won' : ''].filter(Boolean).join(' and ');\n" +
        "  out.push(\"⚠️ <b>Booking merge</b>: couldn't save \" + what + '. It will keep trying every 3 min.');\n" +
        "}\n" +
        "if (fin.moveFailed && !(store.lastMoveFetchWarnAt > Date.now() - 2 * 3600e3)) { store.lastMoveFetchWarnAt = Date.now(); out.push(\"⚠️ <b>Booked → Won</b>: couldn't load the leads to move. Nothing moved, it will try again every 3 min.\"); }\n" +
        "if (plan.moveDryRun && plan.moveReport) {\n" +
        "  if (plan.moves.length) chunked('🧪 <b>Booked → Won (dry run)</b>, nothing changed. Would move ' + plan.moves.length + ' lead(s) to Closed — Won:', plan.moves.map(line));\n" +
        "  else out.push('🧪 <b>Booked → Won (dry run)</b>: nothing to move right now.');\n" +
        "}\n" +
        "if (fin.moved.length && !saveFailed) chunked('✅ <b>Booked in Job Count, moved to Won</b> (' + fin.moved.length + '):', fin.moved.map(line));\n" +
        "return out.map(text => ({ json: { text: text.slice(0, 4000) } }));\n"},
  },
  output: [{ text: '🔗 Booked & merged: Steve Primmer, 0417 400 585 + Gai Primmer (Meta, 26 Oct)' }],
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
  '## Booking merge + booked -> Won\n\n' +
    'Every 3 min: a booked job (booked in Job Count, [Booking Bot] or "Customer booked ... online", last 7 days, not Lost)\n' +
    'with the same AU mobile as a Contacted or Follow Up enquiry (up to 30 days older) is merged:\n' +
    'booking -> Closed — Won with the enquiry history, tick boxes, email, notes and mergedFrom;\n' +
    'enquiry -> archived + mergedInto (never deleted).\n' +
    'Then any other open lead (New, Contacted, Follow Up, Lost Lead, Closed — Lost; any age) whose customer has a Job Count job\n' +
    'from today on (the job\'s own lead, or the same AU mobile) -> Closed — Won. MOVE_DRY_RUN for that part.\n' +
    'Any failed lookup, more than 20 merges or 60 moves at once = nothing done. DRY_RUN at the top of Build Merges.',
  [every3, fetchLeads, fetchBooked, fetchPipeline, buildMerges],
  { color: 5 },
);

export default workflow('rapid-oven-booking-merge', 'Rapid Oven – Booking Merge')
  .add(every3)
  .to(fetchLeads)
  .to(fetchBooked)
  .to(fetchPipeline)
  .to(buildMerges)
  .to(fetchMoveRows)
  .to(buildMoves)
  .to(
    anyToWrite
      .onTrue(saveMerges.to(buildNotes.to(telegram)))
      .onFalse(buildNotes),
  )
  .add(readme);
