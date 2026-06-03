# browser pane groups implementation plan

## goal

make browser aios-native: multiple browser panes behave like tabs/groups inside the shell, not external chrome tabs.

## files

- modify `src/components/BrowserPane.tsx`
- modify `src/lib/browser.ts`
- modify `src/lib/paneRouting.ts`
- modify `src/lib/paneBus.ts`
- modify `src/App.tsx`

## capabilities

- open url in current browser pane
- open url in new browser pane
- open side-by-side comparison panes
- duplicate browser pane
- back / forward / reload
- screenshot / inspect / attach page to chat
- persist browser group state per conversation/project

## phases

1. add browser group metadata to pane layout.
2. add browser command ids.
3. route http links through pane routing by default.
4. add grouped browser tab strip inside pane chrome.
5. add attach-visible-page-to-chat.
6. add ai actions for multi-page research.

## acceptance

- clicking links opens browser panes, not external tabs, unless explicitly requested.
- multiple browser panes can be grouped and switched like tabs.
- ai can open and compare multiple pages.
- page context can be attached to chat.
