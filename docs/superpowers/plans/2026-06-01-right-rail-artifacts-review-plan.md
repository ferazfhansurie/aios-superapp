# right rail artifacts review implementation plan

## goal

make every thread inspectable: activity, files, changes, browser, memory, artifacts, and review in one per-chat rail.

## files

- create `src/components/ThreadRightRail.tsx`
- create `src/components/RunCockpit.tsx`
- create `src/components/ChangesPanel.tsx`
- create `src/components/ArtifactCard.tsx`
- create `src/lib/threadState.ts`
- create `src/lib/artifacts.ts`
- create `src/lib/gitDiff.ts`

## tabs

- activity
- files
- changes
- browser
- memory
- artifacts

## phases

1. build rail shell with persisted width/tab.
2. feed activity tab from run events.
3. add changes tab from git diff commands.
4. add artifact detection from `file.changed` and output paths.
5. add review-this-run command.
6. add pop-out into normal panes.

## acceptance

- every run has an inspectable timeline.
- changed files and diffs are visible.
- generated files become artifacts.
- user can review a run before trusting it.
