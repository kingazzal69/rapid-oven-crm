// In-memory stand-in for the parts of supabase-js the bulk-sms function uses.
// Each awaited query runs to completion before another starts, like a single
// Postgres statement, so conditional updates behave atomically as they would there.
import { randomUUID } from "node:crypto";

const UNIQUE = {
  bulk_sms_templates: [["id"]],
  bulk_sms_migration_markers: [["key"]],
  bulk_sms_suppressions: [["id"], ["canonical_number"]],
  bulk_sms_batches: [["id"], ["client_batch_key"]],
  bulk_sms_recipients: [["id"], ["operation_id"], ["batch_id", "canonical_number"]],
  leads: [["id"]],
};
const AUTO_ID = new Set(["bulk_sms_templates", "bulk_sms_suppressions", "bulk_sms_batches", "bulk_sms_recipients"]);

export function createDb(seed = {}) {
  const tables = {};
  for (const t of Object.keys(UNIQUE)) tables[t] = (seed[t] ?? []).map((r) => structuredClone(r));
  let tick = 0;
  const withDefaults = (table, row) => {
    const out = { ...row };
    if (AUTO_ID.has(table) && !out.id) out.id = randomUUID();
    if (!out.created_at) out.created_at = new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
    return out;
  };
  const clash = (table, row, ignore) =>
    (UNIQUE[table] ?? []).some((cols) =>
      tables[table].some((r) => r !== ignore && cols.every((c) => row[c] !== undefined && JSON.stringify(r[c]) === JSON.stringify(row[c])))
    );
  return { tables, from: (table) => new Query(tables, table, withDefaults, clash) };
}

class Query {
  constructor(tables, table, withDefaults, clash) {
    Object.assign(this, { tables, table, withDefaults, clash, filters: [], op: "select", orders: [], wantRows: false, mode: "many" });
  }
  select() { if (this.op !== "select") this.wantRows = true; return this; }
  insert(rows) { this.op = "insert"; this.payload = [].concat(rows); return this; }
  upsert(rows, opts = {}) { this.op = "upsert"; this.payload = [].concat(rows); this.opts = opts; return this; }
  update(values) { this.op = "update"; this.payload = values; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
  in(col, vals) { this.filters.push((r) => vals.includes(r[col])); return this; }
  order(col, o = {}) { this.orders.push([col, o.ascending === false ? -1 : 1]); return this; }
  range(a, b) { this.rangeArgs = [a, b]; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  single() { this.mode = "single"; return this; }
  then(resolve, reject) { try { resolve(this.run()); } catch (e) { reject(e); } }

  rows() { return this.tables[this.table].filter((r) => this.filters.every((f) => f(r))); }
  shape(data) {
    const copy = structuredClone(data);
    if (this.mode === "many") return { data: copy, error: null };
    if (copy.length > 1) return { data: null, error: { message: "multiple rows" } };
    if (!copy.length) return this.mode === "single" ? { data: null, error: { message: "no rows" } } : { data: null, error: null };
    return { data: copy[0], error: null };
  }
  run() {
    const t = this.tables[this.table];
    if (this.op === "select") {
      let out = this.rows();
      for (const [c, d] of [...this.orders].reverse()) out = [...out].sort((a, b) => (a[c] > b[c] ? d : a[c] < b[c] ? -d : 0));
      if (this.rangeArgs) out = out.slice(this.rangeArgs[0], this.rangeArgs[1] + 1);
      return this.shape(out);
    }
    if (this.op === "insert") {
      const rows = this.payload.map((r) => this.withDefaults(this.table, r));
      const staged = [];
      for (const r of rows) {
        if (this.clash(this.table, r) || staged.some((s) => (UNIQUE[this.table] ?? []).some((cols) => cols.every((c) => r[c] !== undefined && JSON.stringify(s[c]) === JSON.stringify(r[c]))))) {
          return { data: null, error: { message: "duplicate key value violates unique constraint" } };
        }
        staged.push(r);
      }
      t.push(...staged);
      return this.wantRows ? this.shape(staged) : { data: null, error: null };
    }
    if (this.op === "upsert") {
      const key = this.opts.onConflict ?? "id";
      const touched = [];
      for (const raw of this.payload) {
        const existing = t.find((r) => r[key] === raw[key]);
        if (existing) {
          if (this.opts.ignoreDuplicates) continue;
          Object.assign(existing, raw);
          touched.push(existing);
        } else {
          const row = this.withDefaults(this.table, raw);
          if (this.clash(this.table, row)) return { data: null, error: { message: "duplicate key value violates unique constraint" } };
          t.push(row);
          touched.push(row);
        }
      }
      return this.wantRows ? this.shape(touched) : { data: null, error: null };
    }
    if (this.op === "update") {
      const hit = this.rows();
      for (const r of hit) Object.assign(r, this.payload);
      return this.wantRows ? this.shape(hit) : { data: null, error: null };
    }
    if (this.op === "delete") {
      const hit = new Set(this.rows());
      this.tables[this.table] = t.filter((r) => !hit.has(r));
      return { data: null, error: null };
    }
    throw new Error("unsupported op " + this.op);
  }
}
