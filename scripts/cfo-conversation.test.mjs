import test from "node:test";
import assert from "node:assert/strict";
import { parseFinanceMessage } from "./cfo-conversation.mjs";

test("parses expenses and explicit budgets", () => {
  assert.deepEqual(parseFinanceMessage("spent rm20 lunch"), { type: "expense", amount: 20, note: "lunch" });
  assert.deepEqual(parseFinanceMessage("rm45 petrol"), { type: "expense", amount: 45, note: "petrol" });
  assert.deepEqual(parseFinanceMessage("set july budget rm6,700"), { type: "budget", monthName: "july", amount: 6700 });
});

test("rejects ambiguous multiple amounts", () => assert.throws(() => parseFinanceMessage("spent rm20 and rm30")));
