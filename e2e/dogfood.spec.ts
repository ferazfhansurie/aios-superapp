import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The dogfood smoke flow — boots the shell's web build, captures console errors
 * + page errors, asserts the app actually RENDERED (not a blank screen — the
 * exact regression class the loop exists to catch), then best-effort drives a
 * few panes and layout changes, screenshotting each step into the dogfood shots
 * dir so a human (or the next loop cycle) can eyeball what the app looked like.
 *
 * Design choices for a DURABLE first harness (no test-ids exist in the app yet):
 *  - The load-bearing assertions are render + console-clean. These are robust:
 *    they don't couple to specific buttons, so a UI refactor won't break them.
 *  - Pane/layout interaction is BEST-EFFORT (wrapped, non-fatal). It exercises
 *    real handlers for screenshots/signal but never fails the run on a missing
 *    selector — that brittleness waits until the app grows data-testid hooks
 *    (follow-up ticket).
 */

const SHOTS_DIR = join(homedir(), ".aios", "state", "dogfood", "shots");

/** Console noise that's EXPECTED in the web build and must not fail the run:
 *  the shell is a Tauri app; outside Tauri `invoke()` rejects, and a few
 *  browser-intrinsic warnings are unavoidable. Everything else is real signal. */
const BENIGN = [
  /tauri runtime unavailable/i,
  /__TAURI__/i,
  /ResizeObserver loop/i,
  /favicon\.ico/i,
  /Failed to load resource.*404/i,
  /Download the React DevTools/i,
];

function isBenign(text: string): boolean {
  return BENIGN.some((re) => re.test(text));
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`), fullPage: false }).catch(() => {
    /* screenshotting must never fail the flow */
  });
}

test.beforeAll(() => {
  mkdirSync(SHOTS_DIR, { recursive: true });
});

test("dogfood: app boots, renders, and stays console-clean", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (!isBenign(text)) errors.push(text);
  });
  page.on("pageerror", (err) => {
    if (!isBenign(err.message)) errors.push(`pageerror: ${err.message}`);
  });

  // 1. BOOT — wait for the React root to actually mount something.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#root")).toBeAttached();
  // The blank-screen regression = #root present but empty. Assert it has real
  // rendered content (the quota-blank-screen crash class would fail HERE).
  await expect
    .poll(async () => page.locator("#root *").count(), { timeout: 15_000 })
    .toBeGreaterThan(3);
  await page.waitForLoadState("networkidle").catch(() => {});
  await shot(page, "01-boot");

  // 2. BEST-EFFORT pane/layout drive — exercise real handlers for signal. Each
  // step is guarded so a missing affordance logs but never fails the smoke.
  await driveBestEffort(page);
  await shot(page, "02-after-interaction");

  // 3. ASSERT — the load-bearing checks: rendered + no unexpected console errors.
  if (errors.length) {
    console.error(`[dogfood] ${errors.length} console error(s):\n` + errors.join("\n"));
  }
  expect(errors, `unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
});

/** Click a few likely pane-opener buttons + try a layout keyboard shortcut.
 *  Entirely non-fatal — this is for screenshots + handler coverage, not asserts. */
async function driveBestEffort(page: Page): Promise<void> {
  try {
    const buttons = page.locator("button:visible");
    const n = await buttons.count();
    let clicked = 0;
    for (let i = 0; i < n && clicked < 2; i++) {
      const b = buttons.nth(i);
      const name = ((await b.getAttribute("title")) || (await b.textContent()) || "").toLowerCase();
      if (/chat|browser|files|new|add|aios/.test(name)) {
        await b.click({ timeout: 2000 }).catch(() => {});
        clicked++;
        await page.waitForTimeout(400);
      }
    }
    console.log(`[dogfood] best-effort clicked ${clicked} pane-opener button(s) of ${n} visible`);
  } catch (e) {
    console.log(`[dogfood] best-effort interaction skipped: ${(e as Error).message}`);
  }
}
