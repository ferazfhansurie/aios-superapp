// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import { distanceFromBottom, shouldAutoscroll } from "./chatScroll.ts";

test("distanceFromBottom measures how far the viewport is from the live bottom", () => {
  assert.equal(
    distanceFromBottom({ scrollHeight: 1200, scrollTop: 900, clientHeight: 280 }),
    20,
  );
});

test("shouldAutoscroll only pins when already at the bottom and not paused", () => {
  assert.equal(
    shouldAutoscroll(
      { scrollHeight: 1200, scrollTop: 900, clientHeight: 300 },
      false,
    ),
    true,
  );
  assert.equal(
    shouldAutoscroll(
      { scrollHeight: 1200, scrollTop: 860, clientHeight: 300 },
      false,
    ),
    false,
  );
  assert.equal(
    shouldAutoscroll(
      { scrollHeight: 1200, scrollTop: 900, clientHeight: 300 },
      true,
    ),
    false,
  );
});

test("shouldAutoscroll keeps streaming pinned when content grows from the bottom", () => {
  assert.equal(
    shouldAutoscroll(
      {
        previousScrollHeight: 1200,
        scrollHeight: 1340,
        scrollTop: 900,
        clientHeight: 300,
      },
      false,
    ),
    true,
  );
});
