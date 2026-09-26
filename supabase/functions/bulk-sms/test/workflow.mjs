// Runs the JavaScript inside each Code node of n8n/rapid-oven-bulk-sms.workflow.ts against
// sample data, so mistakes in those steps show up before the workflow is ever switched on.
//   node supabase/functions/bulk-sms/test/workflow.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sdk from './n8n-sdk-stub.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const captured = [];
const src = execFileSync('npx', ['--yes', 'esbuild@0.24', join(here, '..', '..', '..', '..', 'n8n', 'rapid-oven-bulk-sms.workflow.ts'), '--format=esm', '--log-level=error'], { encoding: 'utf8' });
const code = src.replace(/import \{[^}]*\} from ["']@n8n\/workflow-sdk["'];/, '').replace(/export \{[^}]*\};?/, '');
const spy = (k) => (arg) => { captured.push(arg); return sdk[k](arg); };
new Function('node','trigger','ifElse','sticky','placeholder','newCredential','expr','workflow', code)(spy('node'), spy('trigger'), spy('ifElse'), sdk.sticky, sdk.placeholder, sdk.newCredential, sdk.expr, sdk.workflow);
const js = (name) => captured.find((c) => c.config.name === name).config.parameters.jsCode;
const run = (name, input, nodes = {}) => new Function('$input', '$', js(name))({ first: () => ({ json: input }) }, (n) => ({ first: () => ({ json: nodes[n] }) }))[0].json;

const body = { batch_id: 'b1', template_name: 'Promo <x>', requested_by: 'aaron@example.com', messages: [
  { operation_id: 'b1:61412345678', to: '61412345678', message: 'Hi Sam' },
  { operation_id: 'b1:61498765432', to: '61498765432', message: 'Hi Jo' },
  { operation_id: 'b1:61411111111', to: '61411111111', message: 'Hi Old' } ] };
const v = run('Validate Batch', { body });
assert.equal(v.ok, true); assert.equal(v.messages.length, 3);
assert.equal(run('Validate Batch', { body: { ...body, batch_id: '' } }).ok, false);
assert.equal(run('Validate Batch', { body: { ...body, messages: [{ operation_id: 'x', to: '0412345678', message: 'hi' }] } }).ok, false, 'non-canonical numbers rejected');
const built = run('Build MobileMessage Request', { ...v, senderId: 'RapidOven' });
assert.deepEqual(built.providerPayload.messages[0], { to: '61412345678', message: 'Hi Sam', sender: 'RapidOven', custom_ref: 'b1:61412345678' });
const mapped = run('Map Provider Results', { status: 'complete', results: [
  { custom_ref: 'b1:61412345678', message_id: 'm1', status: 'success' },
  { custom_ref: 'b1:61498765432', status: 'error' } ] });
assert.deepEqual(mapped.results.map((r) => r.status), ['accepted', 'confirmed_failed']);
for (const [err, want] of [[{ httpCode: '402', message: '402 - payment required' }, 'confirmed_failed'], [{ message: 'The service was not able to process your request (401)' }, 'confirmed_failed'], [{ httpCode: '422' }, 'unknown'], [{ message: 'timeout of 30000ms exceeded' }, 'unknown'], [{ httpCode: '503' }, 'unknown']]) {
  const f = run('Map Failed Request', { error: err }, { 'Build MobileMessage Request': built });
  assert.ok(f.results.every((r) => r.status === want), JSON.stringify(err) + ' -> ' + want);
}
const summary = run('Build Telegram Summary', mapped, { 'Validate Batch': v }).text;
console.log(summary);
assert.match(summary, /Promo &lt;x&gt;/); assert.match(summary, /1 of 3 accepted/); assert.match(summary, /1 rejected: 0498 765 432/); assert.match(summary, /1 not confirmed.*0411 111 111/);
const respond = captured.find((c) => c.config.name === 'Respond Failure').config.parameters.options.responseCode.expr;
console.log('respond code expr:', respond);
console.log('ALL WORKFLOW CODE CHECKS PASSED');
