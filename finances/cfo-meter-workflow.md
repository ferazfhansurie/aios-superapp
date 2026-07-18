# CFO meter update workflow

Use `scripts/cfo-conversation.mjs` for supported Discord `#cfo` expense and budget messages. Pass the Discord message ID as `--event-id` and its timestamp as `--at`; replay is safe. Read back through `scripts/cfo-state.mjs show` and report spent plus remaining budget.

Examples:

```bash
node scripts/cfo-conversation.mjs --message "spent rm20 lunch" --event-id DISCORD_MESSAGE_ID --at 2026-07-16T13:10:00+08:00
node scripts/cfo-conversation.mjs --message "set july budget rm6,700" --event-id DISCORD_MESSAGE_ID --at 2026-07-16T13:10:00+08:00
```

For screenshots, confirm the amount and whether tracked cash changed before invoking the writer. Do not infer or apply a cash delta silently. New months use `cfo-state.mjs init-month` with explicit income, opening spend, budget, cash, floor, debt, and next target.
