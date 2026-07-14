#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { execute } from "./cfo-state.mjs";

export function parseFinanceMessage(message) {
  const text = message.trim().toLowerCase();
  const amounts = [...text.matchAll(/rm\s*([\d,]+(?:\.\d{1,2})?)/g)];
  if (amounts.length !== 1) throw new Error("message must contain exactly one RM amount");
  const amount = Number(amounts[0][1].replaceAll(",", ""));
  const budget = text.match(/^set\s+([a-z]+)\s+budget\s+rm/);
  if (budget) return { type: "budget", monthName: budget[1], amount };
  const expense = text.replace(/^spent\s+/, "").replace(amounts[0][0], "").trim();
  return { type: "expense", amount, note: expense };
}

function opts(args) { const o = {}; for (let i = 0; i < args.length; i += 2) o[args[i].slice(2)] = args[i + 1]; return o; }
async function main() {
  try {
    const o = opts(process.argv.slice(2));
    if (!o.message || !o["event-id"] || !o.at) throw new Error("--message, --event-id and --at are required");
    const parsed = parseFinanceMessage(o.message);
    const current = await execute("show", []);
    const args = parsed.type === "budget" ? ["--month", current.month, "--amount", String(parsed.amount)] : ["--month", current.month, "--event-id", o["event-id"], "--at", o.at, "--kind", "expense", "--amount", String(parsed.amount), "--note", parsed.note, "--source", "discord-cfo"];
    console.log(JSON.stringify(await execute(parsed.type === "budget" ? "set-budget" : "add-adjustment", args), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
