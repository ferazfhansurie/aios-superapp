import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const script = fileURLToPath(new URL("./cfo-state.mjs", import.meta.url));

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "cfo-state-"));
  return { dir, state: join(dir, "cfo.json") };
}

function run(state, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, AIOS_CFO_STATE_PATH: state, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (v) => stdout += v);
    child.stderr.on("data", (v) => stderr += v);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const initArgs = ["init-month", "--month", "2026-07", "--income", "11700", "--opening-spent", "6300", "--budget", "6700", "--cash", "5400", "--cash-floor", "5000", "--card-debt", "4578.91", "--next-target", "7000"];

test("initializes, rounds money, and derives July totals", async () => {
  const { state } = await fixture();
  const roundedArgs = [...initArgs];
  roundedArgs[4] = "11700.005";
  const result = await run(state, roundedArgs);
  assert.equal(result.code, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.income_received, 11700.01);
  assert.equal(json.spent, 6300);
  assert.equal(json.remaining_budget, 400);
  assert.equal(json.net_cash, 821.09);
  assert.equal((await stat(state)).mode & 0o777, 0o600);
  assert.notEqual((await run(state, initArgs)).code, 0);
});

test("expense with cash delta is replay safe", async () => {
  const { state } = await fixture();
  await run(state, initArgs);
  const args = ["add-adjustment", "--month", "2026-07", "--event-id", "discord-1", "--at", "2026-07-16T13:10:00+08:00", "--kind", "expense", "--amount", "20", "--cash-delta", "-20", "--note", "lunch"];
  const first = JSON.parse((await run(state, args)).stdout);
  const replay = JSON.parse((await run(state, args)).stdout);
  assert.equal(first.spent, 6320);
  assert.equal(first.remaining_budget, 380);
  assert.equal(first.cash, 5380);
  assert.equal(replay.revision, first.revision);
  assert.equal(replay.adjustments.length, 1);
});

test("budget changes without changing spend", async () => {
  const { state } = await fixture();
  await run(state, initArgs);
  const changed = await run(state, ["set-budget", "--month", "2026-07", "--amount", "7000"]);
  assert.equal(changed.code, 0, changed.stderr);
  const json = JSON.parse(changed.stdout);
  assert.equal(json.spend_budget, 7000);
  assert.equal(json.spent, 6300);
});

test("tracks receivables separately from bank cash and derives projected cash", async () => {
  const { state } = await fixture();
  await run(state, initArgs);
  const changed = await run(state, ["set-receivable", "--id", "faeez", "--person", "Faeez", "--gross", "2700", "--deductions", "600", "--note", "RM550 medicine + RM50 petrol"]);
  assert.equal(changed.code, 0, changed.stderr);
  const json = JSON.parse(changed.stdout);
  assert.equal(json.cash, 5400);
  assert.equal(json.receivables[0].amount, 2100);
  assert.equal(json.projected_cash, 7500);
});

test("tracks business cash separately and derives total liquid cash", async () => {
  const { state } = await fixture();
  await run(state, initArgs);
  const changed = await run(state, ["set-balance", "--field", "business_cash", "--amount", "2350"]);
  assert.equal(changed.code, 0, changed.stderr);
  const json = JSON.parse(changed.stdout);
  assert.equal(json.cash, 5400);
  assert.equal(json.business_cash, 2350);
  assert.equal(json.liquid_cash, 7750);
});

test("enforces signs, month timestamps, and non-negative spend", async () => {
  const { state } = await fixture();
  await run(state, initArgs);
  for (const args of [
    ["add-adjustment", "--month", "2026-07", "--event-id", "bad-1", "--at", "2026-07-16T00:00:00+08:00", "--kind", "refund", "--amount", "10"],
    ["add-adjustment", "--month", "2026-07", "--event-id", "bad-2", "--at", "2026-08-01T00:00:00+08:00", "--kind", "expense", "--amount", "10"],
    ["add-adjustment", "--month", "2026-07", "--event-id", "bad-3", "--at", "2026-07-16T00:00:00+08:00", "--kind", "correction", "--amount", "-7000"],
  ]) assert.notEqual((await run(state, args)).code, 0);
});

test("canonical lock serializes concurrent writers", async () => {
  const { state } = await fixture();
  await run(state, initArgs);
  const base = ["add-adjustment", "--month", "2026-07", "--at", "2026-07-16T13:10:00+08:00", "--kind", "expense", "--amount", "10"];
  const [a, b] = await Promise.all([
    run(state, [...base, "--event-id", "concurrent-a"]),
    run(state, [...base, "--event-id", "concurrent-b"]),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  const shown = JSON.parse((await run(state, ["show"])).stdout);
  assert.equal(shown.spent, 6320);
  assert.equal(shown.adjustments.length, 2);
});

test("rollover archives without carrying spend or adjustments", async () => {
  const { state } = await fixture();
  await run(state, initArgs);
  await run(state, ["add-adjustment", "--month", "2026-07", "--event-id", "jul-1", "--at", "2026-07-16T00:00:00+08:00", "--kind", "expense", "--amount", "20"]);
  const next = ["init-month", "--month", "2026-08", "--income", "0", "--opening-spent", "0", "--budget", "3700", "--cash", "7000", "--cash-floor", "7000", "--card-debt", "4578.91", "--next-target", "8000"];
  const result = await run(state, next);
  assert.equal(result.code, 0, result.stderr);
  const current = JSON.parse(result.stdout);
  assert.equal(current.month, "2026-08");
  assert.equal(current.opening_spent, 0);
  assert.equal(current.adjustments.length, 0);
  const archived = JSON.parse(await readFile(join(dirname(state), "history", "2026-07.json"), "utf8"));
  assert.equal(archived.adjustments.length, 1);
  const late = await run(state, ["add-adjustment", "--month", "2026-07", "--event-id", "late-1", "--at", "2026-07-20T00:00:00+08:00", "--kind", "correction", "--amount", "5"]);
  assert.equal(late.code, 0, late.stderr);
  assert.equal(JSON.parse((await run(state, ["show"])).stdout).month, "2026-08");
});
