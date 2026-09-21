# Chinese UI integration — fork work in progress

## 当前状态 / Current status

这是 `MJYKIM99/codex-router:codex/chinese-ui-integration` 的接续说明。
分支从 #839 的 `70f9b2a096e5c19d502c088ec5c0247308c8372d` 创建，保留原 PR
历史。这是**已提交代码的整合工作分支，不是全量简繁中文完成版**。原 PR 分支
`codex/improve-simplified-chinese-ui` 没有随本次发布推进。

This is an isolated fork staging branch. Do not promote it to the existing PR
until implementation and integration verification below are complete. It is not
merely waiting for a final push: renderer/panel/native implementation remains.

### What is implemented

- One native-menu structure and three separately maintained resources: English,
  Simplified Chinese and Traditional Chinese, with 29 semantic message keys each.
- Script-aware system-locale matching; explicit Hans/Hant outranks region.
  Existing `zh-CN` / `zh-TW` preference IDs are retained.
- The existing trusted-renderer, fixed-language-ID IPC; menu roles and callbacks
  do not come from translated text. Other supported menu languages retain the
  previous English fallback.
- Expanded dictionary/locale tests and an actual-main-source VM harness with
  mocked Electron/OS boundaries. Its image mock supports the template-image
  method used by the newly merged upstream tray fix.
- `new-ui-copy.draft.json`: 54 English/Simplified/Traditional message drafts.
  These are **not imported by runtime code and are not localization coverage**.

### Important remaining gaps

The old renderer can still report its old language selection after bootstrap,
overriding the initial menu language. A complete `zh-TW` picker, shared language
resolution, reload persistence, all eight Control Center pages, browser panel,
Swift tray/notch, and widget Traditional Chinese resources are not implemented
by this menu-foundation commit. Do not describe a menu-only result as a complete
Traditional Chinese app.

## Upstream changed while this branch was prepared

Checked upstream main: `0606f10f6f899fb2c34f755f98bcd347d6be52e6`.
It merged #836 at **2026-09-21 18:53:28 UTC**. #839 now reports
`mergeable: false`; the previous conflict-free result against `9c0db45` is stale.
This staging branch has **not** merged the new main or resolved those conflicts.

- #836 is now merged: retain its selected-account groups, cache-telemetry
  distinctions, tray template assets, and all backend fixes when integrating.
- #857 is still open at `d795cb9bad4a6dbc08662b6608cadbcc8f312f00`; its current
  metadata also reports a merge conflict. Its typed-key work is a source to
  adapt with attribution, not code silently claimed as already adopted here.
- #853 custom-endpoint UI was still open at the last source check
  (`e14bff0c6fe763746f5ef437382e3e3e108245c9`). Recheck before implementation.
  Do not import an unmerged feature's UI without its backend contracts merely
  to translate its labels.

Sources: [#839](https://github.com/duolahypercho/codex-router/pull/839),
[#836](https://github.com/duolahypercho/codex-router/pull/836),
[#857](https://github.com/duolahypercho/codex-router/pull/857),
[#853](https://github.com/duolahypercho/codex-router/pull/853).

## 在本机接续 / Local continuation

Use a fresh directory so no existing worktree or uncommitted work is replaced:

```sh
git clone --branch codex/chinese-ui-integration https://github.com/MJYKIM99/codex-router.git codex-router-chinese
cd codex-router-chinese
git status --short
node --version
```

Use the repository CI's Node 24 for complete validation. The focused menu tests
also ran here under Linux / Node 22.16.0, without installing npm dependencies:

```sh
node --test test/control-center-interface-menu.test.mjs test/control-center-interface-menu-lifecycle.test.mjs
```

Then fetch and inspect main before resolving its conflicts in this staging
branch. Do not replace whole conflicted files with `--ours` or `--theirs`:

```sh
git remote add upstream https://github.com/duolahypercho/codex-router.git
git fetch upstream
git log --oneline --max-count=12 upstream/main
git merge --no-commit --no-ff upstream/main
```

The merge can stop with conflicts; that is expected, not a reason to force it.
Review the resolved diff before committing. `git merge --abort` abandons this
merge attempt when needed. It does not perform the remaining localization work.

### Implementation order and non-negotiable behavior

1. **Reconcile main first.** In `UsagePage.tsx`, retain #836's distinction between
   missing cache telemetry and a measured zero hit rate, its selected-account
   grouping, and quota/reset calculations. Keep the new template-image tray
   behavior alongside translated menus. Merge both sides of shared types and
   tests rather than choosing one whole file.
2. **Unify renderer and panel APIs.** Adapt #857's existing typed `t(key, values)`
   approach, keeping English as the key schema and explicit complete `zh-CN`
   and `zh-TW` dictionaries. Migrate shared formatter signatures and all callers
   together. Other locales retain documented English fallback for new keys.
   Preserve #839's date/number locale handling and language-dependent memos.
   Retain contributor attribution for adapted #857 work; do not close its PR
   or claim maintainer agreement on someone else's behalf.
3. **Wire locale selection and persistence atomically.** Saved preference wins
   over system locale. Normalize aliases consistently in renderer, panel and
   main; update `html.lang`, direction, derived labels and menus. Keep a single
   bounded language-ID menu IPC, not two mechanisms racing to overwrite labels.
   Only expose complete `zh-TW` selection together with its page dictionaries.
4. **Preserve and extend native work.** Keep #839's Swift tray/notch and optional
   widget snapshot-language field, including older-snapshot decoding. Add real
   Traditional Chinese resources and update both `project.yml` and the checked-in
   Xcode project. Verify no duplicate tray/menu owner is introduced.
5. **Localize landed new UI.** Wire the Usage/Doctor drafts into actual visible
   call sites using the chosen catalog, preserving all data semantics. Wire
   custom-endpoint text only after the feature is present or maintainers agree
   on a separate stacked integration. Reconcile provisional draft IDs; do not
   introduce duplicate keys or count unused resources as complete pages.

Never translate model/provider IDs, effort values, commands, paths, credentials,
API protocol names, user content, or unknown provider errors. Translate complete
known messages, interpolate runtime values as text, and never use translated
labels as sorting/routing/state identifiers. Do not use runtime Simplified-to-
Traditional conversion in place of an independently maintained dictionary.

## Verification and promotion gate

Locally rerun for the code published in the menu-foundation commit:

| Check | Result and scope |
| --- | --- |
| Original edited files match fetched Git blob hashes | Passed |
| Focused menu and entry-point VM tests | 80 passed; 0 failed; 0 skipped |
| Modified/new JavaScript syntax | Passed |
| Targeted JSDoc menu/locale type check | Passed; not project-wide TypeScript |
| Draft-message IDs and placeholder consistency | 54 checked; not UI coverage |
| Full repository check/test; real renderer and packages | Not run here |
| Native macOS/Windows, Swift and Xcode | Not run here |
| New-main merge and full simplifed/traditional integration | Pending |

The VM tests simulate Linux, Windows and macOS branches; they do not run native
Electron on those systems. Historical #839 results are not fresh results for
this integration. The environment provided only a source subset for local
execution, not a full checkout, so the repository maintainer analyzer and full
impact verification must be run in the real checkout before promotion.

After implementation, run the project's real entry points, not just the 80
menu checks. A useful baseline is:

```sh
npm ci
npm run check
npm test
npm --prefix apps/control-center ci
npm --prefix apps/control-center run check
npm --prefix apps/control-center test
npm --prefix apps/control-center run build
```

Also run the browser-panel tests, the repository maintainer analyzer, and the
Swift/Xcode/native-package checks prescribed by `AGENTS.md` and CI. Verify all
three language directions and reloads with explicit test locales, every page,
search/dialog/accessibility text, new Usage behavior, effort label/value
separation, and the widget snapshot. Do not run quota-consuming live probes or
publish releases as part of this handoff. Do not skip failures to obtain green CI.

Push completed work back to the isolated fork branch first:

```sh
git push origin codex/chinese-ui-integration
```

**Only after all pending implementation and required checks are complete**, move
that work to the original PR branch. In the fresh clone above:

```sh
git fetch origin
git switch --track origin/codex/improve-simplified-chinese-ui
git merge --ff-only codex/chinese-ui-integration
git push origin codex/improve-simplified-chinese-ui
```

If the branch already exists locally, switch to it normally instead of creating
it again. If fast-forward is refused, stop and reconcile concurrent work; do
not force-push. Updating the original PR branch updates #839 automatically.
Clean up or replace this WIP handoff and unwired draft file when integration
is complete; they are not a permanent substitute for application catalogs.
