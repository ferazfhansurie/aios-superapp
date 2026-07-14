#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, rm, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid money: ${v}`);
  return Math.round((n + Number.EPSILON) * 100) / 100;
};
const statePath = () => process.env.AIOS_CFO_STATE_PATH || join(homedir(), ".aios/state/finance/cfo.json");
const lockPath = () => `${statePath()}.lock`;
const historyPath = (month) => join(dirname(statePath()), "history", `${month}.json`);

function argsMap(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || args[i + 1] == null) throw new Error(`invalid argument ${args[i] || ""}`);
    out[args[i].slice(2)] = args[i + 1];
  }
  return out;
}

function validate(doc) {
  if (doc.schema_version !== 1 || !/^\d{4}-\d{2}$/.test(doc.month)) throw new Error("invalid schema or month");
  const core = ["income_received", "opening_spent", "spend_budget", "cash", "cash_floor", "card_debt", "next_month_cash_target"];
  for (const key of core) if (!Number.isFinite(doc[key]) || doc[key] < 0) throw new Error(`invalid ${key}`);
  const ids = new Set();
  for (const a of doc.adjustments || []) {
    if (!a.id || ids.has(a.id)) throw new Error("duplicate adjustment id");
    ids.add(a.id);
    if (!Number.isFinite(a.amount) || a.amount === 0) throw new Error("invalid adjustment amount");
    if (a.kind === "expense" && a.amount <= 0) throw new Error("expense must be positive");
    if (a.kind === "refund" && a.amount >= 0) throw new Error("refund must be negative");
    if (a.kind !== "expense" && a.kind !== "refund" && a.kind !== "correction") throw new Error("invalid kind");
    const localMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit" }).format(new Date(a.at)).replace("-", "-");
    if (localMonth !== doc.month) throw new Error("adjustment timestamp outside month");
  }
  if (derive(doc).spent < 0) throw new Error("spent cannot be negative");
  return doc;
}

function derive(doc) {
  const spent = money(doc.opening_spent + (doc.adjustments || []).reduce((s, a) => s + a.amount, 0));
  return { ...doc, spent, remaining_budget: money(doc.spend_budget - spent), net_cash: money(doc.cash - doc.card_debt) };
}

async function readDoc(path = statePath()) {
  return validate(JSON.parse(await readFile(path, "utf8")));
}

async function atomicWrite(path, doc) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

async function withLock(fn) {
  await mkdir(dirname(statePath()), { recursive: true });
  const deadline = Date.now() + 2000;
  while (true) {
    try { await mkdir(lockPath()); break; }
    catch (e) {
      if (e.code !== "EEXIST" || Date.now() >= deadline) throw new Error("finance state lock timeout");
      await sleep(15 + Math.floor(Math.random() * 25));
    }
  }
  try { return await fn(); } finally { await rm(lockPath(), { recursive: true, force: true }); }
}

function newDoc(o) {
  const doc = {
    schema_version: 1, revision: 1, updated_at: new Date().toISOString(), currency: "MYR", month: o.month,
    income_received: money(o.income), opening_spent: money(o["opening-spent"]), spend_budget: money(o.budget),
    cash: money(o.cash), cash_floor: money(o["cash-floor"]), card_debt: money(o["card-debt"]),
    next_month_cash_target: money(o["next-target"]), adjustments: [],
  };
  return validate(doc);
}

export async function execute(command, argv) {
  const o = argsMap(argv);
  if (command === "show") return derive(await readDoc());
  return withLock(async () => {
    if (command === "init-month") {
      const next = newDoc(o);
      let current = null;
      try { current = await readDoc(); } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (current) {
        if (current.month === next.month) throw new Error("current month already initialized");
        if (next.month <= current.month) throw new Error("new month must follow current month");
        const archive = historyPath(current.month);
        await mkdir(dirname(archive), { recursive: true });
        try {
          const existing = await readDoc(archive);
          if (JSON.stringify(existing) !== JSON.stringify(current)) throw new Error("archive conflict");
        } catch (e) {
          if (e.code === "ENOENT") await atomicWrite(archive, current); else throw e;
        }
      }
      await atomicWrite(statePath(), next);
      return derive(await readDoc());
    }
    const month = o.month;
    const current = await readDoc();
    const targetPath = month && month !== current.month ? historyPath(month) : statePath();
    const doc = targetPath === statePath() ? current : await readDoc(targetPath);
    if (command === "add-adjustment") {
      if (month !== doc.month) throw new Error("month mismatch");
      const existing = doc.adjustments.find((a) => a.id === o["event-id"]);
      if (existing) return derive(doc);
      const adjustment = { id: o["event-id"], at: o.at, kind: o.kind, amount: money(o.amount), category: o.category || "", note: o.note || "", source: o.source || "manual" };
      doc.adjustments.push(adjustment);
      if (o["cash-delta"] != null) doc.cash = money(doc.cash + money(o["cash-delta"]));
    } else if (command === "set-budget") {
      if (month !== doc.month || targetPath !== statePath()) throw new Error("budget month mismatch");
      doc.spend_budget = money(o.amount);
    } else if (command === "set-balance") {
      const fields = { cash: "cash", card_debt: "card_debt", income_received: "income_received", cash_floor: "cash_floor", next_month_cash_target: "next_month_cash_target" };
      const field = fields[o.field];
      if (!field) throw new Error("invalid balance field");
      doc[field] = money(o.amount);
    } else throw new Error(`unknown command: ${command}`);
    doc.revision += 1;
    doc.updated_at = new Date().toISOString();
    validate(doc);
    await atomicWrite(targetPath, doc);
    return derive(await readDoc(targetPath));
  });
}

async function main() {
  try { console.log(JSON.stringify(await execute(process.argv[2], process.argv.slice(3)), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
