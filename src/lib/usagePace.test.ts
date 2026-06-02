// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import { usagePaceRisk } from "./usagePace.ts";

test("usagePaceRisk warns when current burn will empty before reset", () => {
  const now = 1_000_000;
  const reset = now + 4 * 3600 + 20 * 60;

  assert.deepEqual(
    usagePaceRisk({
      pct: 24,
      resetsAt: reset,
      windowSeconds: 5 * 3600,
      nowSeconds: now,
    }),
    {
      level: "warning",
      title: "fast pace",
      detail: "empty in 2h 6m before reset",
    },
  );
});

test("usagePaceRisk stays quiet when usage is on pace for the window", () => {
  const now = 1_000_000;
  const reset = now + 3 * 3600;

  assert.equal(
    usagePaceRisk({
      pct: 20,
      resetsAt: reset,
      windowSeconds: 5 * 3600,
      nowSeconds: now,
    }),
    null,
  );
});

test("usagePaceRisk escalates near exhaustion", () => {
  const now = 1_000_000;
  const reset = now + 2 * 3600;

  assert.deepEqual(
    usagePaceRisk({
      pct: 91,
      resetsAt: reset,
      windowSeconds: 5 * 3600,
      nowSeconds: now,
    }),
    {
      level: "danger",
      title: "slow down",
      detail: "empty in 17m before reset",
    },
  );
});
