// @ts-nocheck -- executed directly by node's test runner, outside the browser app.
import assert from "node:assert/strict";
import test from "node:test";

import { commandToPaletteCommand, createCommand, runCommand } from "./commands.ts";
import { buildAppCommands } from "./appCommands.ts";
import { chatHandles, detachBusyChats } from "./paneBus.ts";

test("command registry commands expose metadata and disabled state", () => {
  const command = createCommand({
    id: "pane.close",
    label: "close pane",
    description: "close the active pane",
    scope: "pane",
    danger: "destructive",
    enabled: (ctx) => Boolean(ctx.activePaneKey),
    run: () => ({ ok: true }),
  });

  assert.equal(command.id, "pane.close");
  assert.equal(command.danger, "destructive");
  assert.equal(command.enabled({ activePaneKey: null }), false);
  assert.equal(command.enabled({ activePaneKey: "pane-1" }), true);
});

test("commandToPaletteCommand preserves one command id for palette execution", async () => {
  const calls: string[] = [];
  const command = createCommand({
    id: "app.settings.open",
    label: "settings",
    description: "open settings",
    scope: "global",
    keywords: ["preferences", "theme"],
    run: (ctx) => {
      calls.push(ctx.source);
      return { ok: true, message: "opened" };
    },
  });

  const palette = commandToPaletteCommand(command, {
    context: { source: "palette" },
    group: "app",
    actionLabel: "open",
  });

  assert.equal(palette.id, "app.settings.open");
  assert.equal(palette.title, "settings");
  assert.equal(palette.subtitle, "open settings");
  assert.equal(palette.keywords, "preferences theme");

  await palette.run();
  assert.deepEqual(calls, ["palette"]);
});

test("runCommand returns disabled result instead of executing", async () => {
  let ran = false;
  const command = createCommand({
    id: "run.focused",
    label: "run focused project",
    scope: "global",
    enabled: () => false,
    run: () => {
      ran = true;
      return { ok: true };
    },
  });

  const result = await runCommand(command, { source: "test" });

  assert.equal(result.ok, false);
  assert.equal(result.error, "command disabled");
  assert.equal(ran, false);
});

test("detachBusyChats backgrounds only active chat generations", () => {
  const calls: string[] = [];
  chatHandles.clear();
  chatHandles.set("idle", {
    busy: () => false,
    detach: () => calls.push("idle"),
  });
  chatHandles.set("busy", {
    busy: () => true,
    detach: (notify) => calls.push(`busy:${notify}`),
  });

  assert.equal(detachBusyChats(true), 1);
  assert.deepEqual(calls, ["busy:true"]);
  chatHandles.clear();
});

test("buildAppCommands exposes shell command groups without App.tsx owning registry", async () => {
  const calls: string[] = [];
  const commands = buildAppCommands({
    activeKey: "pane-1",
    panesCount: 2,
    home: "/Users/firaz",
    chats: [{ id: "chat-1", title: "plan", cwd: "/Users/firaz/repo", mtime: 1 }],
    oracles: [{
      socket: "adletic",
      is_master: false,
      running: true,
      identity: "firaz",
      session: "aios-firaz",
      display_name: "firaz",
      attached: true,
    }],
    customers: [{ id: "cust-1", name: "tika", handle: "601", lastAgo: "2m", channel: "whatsapp" }],
    projects: [{ name: "shell", root: "/Users/firaz/aios/shell", kind: "node", commands: [] }],
    spawn: (_kind, label) => calls.push(`spawn:${label}`),
    resumeChat: (chat) => calls.push(`resume:${chat.id}`),
    addOracle: (identity) => calls.push(`oracle:${identity}`),
    runProject: (project) => calls.push(`project:${project.name}`),
    runF5: () => calls.push("f5"),
    reloadProjects: () => calls.push("reload-projects"),
    fireAppshot: () => calls.push("appshot"),
    setSidebarOpen: () => calls.push("sidebar"),
    setTopBarMode: (mode) => calls.push(`topbar:${mode}`),
    setOverviewOpen: () => calls.push("overview"),
    setSettingsOpen: () => calls.push("settings"),
    setHiddenKeys: () => calls.push("hidden"),
    setMaximizedKey: () => calls.push("maximized"),
  });

  const byId = new Map(commands.map((c) => [c.id, c]));
  assert.equal(byId.get("pane.open.chat")?.group, "open");
  assert.equal(byId.get("chat.resume.chat-1")?.group, "resume");
  assert.equal(byId.get("oracle.attach.firaz")?.actionLabel, "attach");
  assert.equal(byId.get("customer.open.cust-1")?.group, "customers");
  assert.equal(byId.get("project.run./Users/firaz/aios/shell")?.subtitle, "node · aios/shell");
  assert.equal(byId.get("project.rescan")?.group, "run");
  assert.equal(byId.get("project.run.focused")?.actionLabel, "run");
  assert.equal(byId.get("view.overview.open")?.group, "view");
  assert.equal(byId.get("app.settings.open")?.group, "app");

  await byId.get("pane.open.chat")?.run();
  await byId.get("project.run./Users/firaz/aios/shell")?.run();
  await byId.get("project.run.focused")?.run();
  await byId.get("project.rescan")?.run();
  await byId.get("app.settings.open")?.run();
  assert.deepEqual(calls, ["spawn:chat", "project:shell", "f5", "reload-projects", "settings"]);
});
