import { workflow, node, trigger, sticky, placeholder, newCredential, ifElse, expr } from '@n8n/workflow-sdk';

const smsWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Bulk SMS Webhook',
    position: [240, 300],
    parameters: {
      httpMethod: 'POST',
      path: 'rapid-oven-bulk-sms',
      authentication: 'headerAuth',
      responseMode: 'responseNode',
      options: {},
    },
    credentials: { httpHeaderAuth: newCredential('Rapid Oven Bulk SMS Webhook Secret') },
  },
  output: [{ headers: { 'x-crm-sms-secret': '***' }, body: { batch_id: 'b1', template_name: 'Quote follow-up', requested_by: 'aaron@example.com', messages: [{ operation_id: 'b1:61412345678', to: '61412345678', message: "Hi Sam, it's Brenna from Rapid Oven Cleaning..." }] } }],
});

const normalizeInput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate Batch',
    position: [540, 300],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const body = $input.first().json.body ?? {};\n" +
        "const batchId = typeof body.batch_id === 'string' ? body.batch_id : '';\n" +
        "const messages = Array.isArray(body.messages) ? body.messages : [];\n" +
        "if (!/^[A-Za-z0-9._:-]{1,160}$/.test(batchId)) {\n" +
        "  return [{ json: { ok: false, error: 'A valid batch_id is required.' } }];\n" +
        "}\n" +
        "if (!messages.length || messages.length > 10000) {\n" +
        "  return [{ json: { ok: false, error: 'messages must contain between 1 and 10000 entries.' } }];\n" +
        "}\n" +
        "for (const m of messages) {\n" +
        "  const opId = typeof m.operation_id === 'string' ? m.operation_id : '';\n" +
        "  const to = typeof m.to === 'string' ? m.to.replace(/\\D/g, '') : '';\n" +
        "  const message = typeof m.message === 'string' ? m.message.trim() : '';\n" +
        "  if (!opId || !/^614\\d{8}$/.test(to) || !message) {\n" +
        "    return [{ json: { ok: false, error: 'Every message needs an operation_id, a canonical 614XXXXXXXX number, and non-empty text.' } }];\n" +
        "  }\n" +
        "}\n" +
        "return [{ json: {\n" +
        "  ok: true,\n" +
        "  batch_id: batchId,\n" +
        "  template_name: typeof body.template_name === 'string' ? body.template_name.slice(0, 120) : '',\n" +
        "  requested_by: typeof body.requested_by === 'string' ? body.requested_by : '',\n" +
        "  messages: messages.map((m) => ({ operation_id: m.operation_id, to: m.to.replace(/\\D/g, ''), message: String(m.message).trim() })),\n" +
        "} }];",
    },
  },
  output: [{ ok: true, batch_id: 'b1', template_name: 'Quote follow-up', requested_by: 'aaron@example.com', messages: [{ operation_id: 'b1:61412345678', to: '61412345678', message: 'Hi Sam...' }] }],
});

const isValid = ifElse({
  version: 2.3,
  config: {
    name: 'Batch Valid?',
    position: [840, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: expr('{{ $json.ok }}'), operator: { type: 'boolean', operation: 'true' }, rightValue: true }],
        combinator: 'and',
      },
    },
  },
});

const respondInvalid = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Invalid',
    position: [1140, 460],
    parameters: {
      respondWith: 'json',
      responseBody: { error: expr('{{ $json.error }}') },
      options: { responseCode: 400 },
    },
  },
});

const injectSender = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Add Sender ID',
    position: [1140, 200],
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 'sender-id', name: 'senderId', value: placeholder('Your registered MobileMessage sender ID (dedicated number or ACMA-registered alphanumeric ID)'), type: 'string' },
        ],
      },
    },
  },
  output: [{ ok: true, batch_id: 'b1', senderId: 'RapidOven', messages: [{ operation_id: 'b1:61412345678', to: '61412345678', message: 'Hi Sam...' }] }],
});

const buildProviderRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build MobileMessage Request',
    position: [1440, 200],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const data = $input.first().json;\n" +
        "const providerPayload = {\n" +
        "  messages: data.messages.map((m) => ({ to: m.to, message: m.message, sender: data.senderId, custom_ref: m.operation_id })),\n" +
        "};\n" +
        "return [{ json: { ...data, providerPayload } }];",
    },
  },
  output: [{ ok: true, batch_id: 'b1', messages: [{ operation_id: 'b1:61412345678', to: '61412345678', message: 'Hi Sam...' }], providerPayload: { messages: [{ to: '61412345678', message: 'Hi Sam...', sender: 'RapidOven', custom_ref: 'b1:61412345678' }] } }],
});

const sendToMobileMessage = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Send via MobileMessage',
    position: [1740, 200],
    onError: 'continueErrorOutput',
    parameters: {
      method: 'POST',
      url: 'https://api.mobilemessage.com.au/v1/messages',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBasicAuth',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'Idempotency-Key', value: expr('{{ $json.batch_id }}') }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ $json.providerPayload }}'),
      options: { timeout: 30000 },
    },
    credentials: { httpBasicAuth: newCredential('MobileMessage API') },
  },
  output: [{ results: [{ custom_ref: 'b1:61412345678', message_id: 'mm_123', status: 'queued' }] }],
});

const mapProviderResults = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Map Provider Results',
    position: [2040, 100],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "// UNVERIFIED: this session could not reach mobilemessage.com.au to confirm the exact\n" +
        "// response shape (network egress to that domain was blocked). Confirm against the\n" +
        "// real account response before activating, then simplify this parsing.\n" +
        "const body = $input.first().json ?? {};\n" +
        "const rows = Array.isArray(body.results) ? body.results\n" +
        "  : Array.isArray(body.messages) ? body.messages\n" +
        "  : Array.isArray(body) ? body\n" +
        "  : [];\n" +
        "const results = rows.map((r) => {\n" +
        "  const operationId = r.custom_ref || r.operation_id || '';\n" +
        "  const providerMessageId = r.message_id || r.id || null;\n" +
        "  const rawStatus = String(r.status || '').toLowerCase();\n" +
        "  const status = ['queued', 'sent', 'accepted', 'success'].includes(rawStatus) ? 'accepted'\n" +
        "    : ['failed', 'rejected', 'invalid', 'error'].includes(rawStatus) ? 'confirmed_failed'\n" +
        "    : 'unknown';\n" +
        "  return { operation_id: operationId, status, provider_message_id: providerMessageId, raw: r };\n" +
        "});\n" +
        "return [{ json: { results } }];",
    },
  },
  output: [{ results: [{ operation_id: 'b1:61412345678', status: 'accepted', provider_message_id: 'mm_123', raw: {} }] }],
});

const respondAccepted = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Accepted',
    position: [2340, 100],
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ $json }}'),
      options: { responseCode: 200 },
    },
  },
});

const mapAmbiguousFailure = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Map Failed Request',
    position: [2040, 320],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "// MobileMessage refused or didn't answer. A clear refusal (bad login, no credit, invalid\n" +
        "// request, rate limit) means nothing was sent. Anything else (timeout, 5xx, 409/422\n" +
        "// idempotency clashes) might have been sent, so it is reported unknown and never retried here.\n" +
        "const err = $input.first().json.error ?? {};\n" +
        "const code = Number(err.httpCode || err.status || (String(err.message || '').match(/\\b([45]\\d\\d)\\b/) || [])[1] || 0);\n" +
        "const definite = [400, 401, 402, 403, 429].includes(code);\n" +
        "const messages = $('Build MobileMessage Request').first().json.messages;\n" +
        "const results = messages.map((m) => ({ operation_id: m.operation_id, status: definite ? 'confirmed_failed' : 'unknown', provider_message_id: null }));\n" +
        "return [{ json: { results, note: definite ? 'MobileMessage refused the request (HTTP ' + code + ').' : 'MobileMessage did not give a clear answer; outcome unknown.' } }];",
    },
  },
  output: [{ results: [{ operation_id: 'b1:61412345678', status: 'unknown', provider_message_id: null }], note: 'MobileMessage did not give a clear answer; outcome unknown.' }],
});

const respondAmbiguous = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Failure',
    position: [2340, 320],
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ $json }}'),
      options: { responseCode: expr('{{ $json.results.every((r) => r.status === "confirmed_failed") ? 200 : 502 }}') },
    },
  },
});

const buildTelegramSummary = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Telegram Summary',
    position: [2640, 200],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const batch = $('Validate Batch').first().json;\n" +
        "const out = $input.first().json;\n" +
        "const results = Array.isArray(out.results) ? out.results : [];\n" +
        "const byOp = new Map(batch.messages.map((m) => [m.operation_id, m.to]));\n" +
        "const fmt = (n) => (n && n.length === 11 ? '0' + n.slice(2, 5) + ' ' + n.slice(5, 8) + ' ' + n.slice(8) : n || '?');\n" +
        "const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\n" +
        "const list = (arr) => arr.slice(0, 10).map((r) => fmt(byOp.get(r.operation_id))).join(', ') + (arr.length > 10 ? ' +' + (arr.length - 10) + ' more' : '');\n" +
        "const reported = new Set(results.map((r) => r.operation_id));\n" +
        "const accepted = results.filter((r) => r.status === 'accepted');\n" +
        "const failed = results.filter((r) => r.status === 'confirmed_failed');\n" +
        "const unknown = results.filter((r) => r.status !== 'accepted' && r.status !== 'confirmed_failed')\n" +
        "  .concat(batch.messages.filter((m) => !reported.has(m.operation_id)).map((m) => ({ operation_id: m.operation_id })));\n" +
        "const lines = ['<b>Bulk SMS</b> \u2014 ' + esc(batch.template_name || 'Custom message')];\n" +
        "lines.push('\u2705 ' + accepted.length + ' of ' + batch.messages.length + ' accepted by MobileMessage');\n" +
        "if (failed.length) lines.push('\u274c ' + failed.length + ' rejected: ' + esc(list(failed)));\n" +
        "if (unknown.length) lines.push('\u26a0\ufe0f ' + unknown.length + ' not confirmed \u2014 check MobileMessage before resending: ' + esc(list(unknown)));\n" +
        "if (out.note) lines.push(esc(out.note));\n" +
        "lines.push('Sent by ' + esc(batch.requested_by || 'unknown'));\n" +
        "return [{ json: { text: lines.join('\\n') } }];",
    },
  },
  output: [{ text: '<b>Bulk SMS</b> \u2014 Quote follow-up\n\u2705 1 of 1 accepted by MobileMessage\nSent by aaron@example.com' }],
});

const telegramNotify = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Telegram Confirmation',
    position: [2940, 200],
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: placeholder('Your Telegram chat ID (the same chat your other Rapid Oven bots message you in)'),
      text: expr('{{ $json.text }}'),
      additionalFields: { parse_mode: 'HTML', appendAttribution: false },
    },
    credentials: { telegramApi: newCredential('Telegram Bot') },
  },
  output: [{ ok: true }],
});

const readme = sticky(
  '## Bulk SMS → MobileMessage\n\n' +
    'Inactive on import. Before enabling:\n' +
    '1. Fill in the MobileMessage API Basic Auth credential and the webhook header-auth\n' +
    '   secret (must match N8N_SMS_WEBHOOK_SECRET / X-CRM-SMS-Secret on the Edge Function).\n' +
    '2. Set the sender ID placeholder on "Add Sender ID" to your registered MobileMessage sender.\n' +
    '3. Verify the exact MobileMessage response shape against your live account (this build\'s\n' +
    '   "Map Provider Results" node was written from search-engine summaries of the public docs,\n' +
    '   not a first-hand fetch — this session\'s network policy blocked mobilemessage.com.au).\n' +
    '4. Confirm Idempotency-Key behaviour (24h retention, per-API-key scope) matches what you see.\n' +
    '5. On "Telegram Confirmation", pick your existing Telegram bot credential and set your chat ID.\n\n' +
    'Contract with the Edge Function: HTTP 200 with {results:[{operation_id, status:\n' +
    'accepted|confirmed_failed|unknown, provider_message_id}]} when MobileMessage gave a clear\n' +
    'answer (including a clear refusal, where every text is confirmed_failed). Timeouts and unclear\n' +
    'errors return 502, so the Edge Function marks every text unknown and never resends it.',
  [smsWebhook, normalizeInput, isValid, respondInvalid, injectSender, buildProviderRequest, sendToMobileMessage, mapProviderResults, respondAccepted, mapAmbiguousFailure, respondAmbiguous, buildTelegramSummary, telegramNotify],
  { color: 5 },
);

export default workflow('rapid-oven-bulk-sms', 'Rapid Oven – Bulk SMS (MobileMessage)')
  .add(smsWebhook)
  .to(normalizeInput)
  .to(
    isValid
      .onTrue(
        injectSender.to(
          buildProviderRequest.to(
            sendToMobileMessage
              .to(mapProviderResults.to(respondAccepted.to(buildTelegramSummary.to(telegramNotify))))
              .onError(mapAmbiguousFailure.to(respondAmbiguous.to(buildTelegramSummary))),
          ),
        ),
      )
      .onFalse(respondInvalid),
  )
  .add(readme);
