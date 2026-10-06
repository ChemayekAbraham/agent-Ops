# GitHub sync conflicts: cause, prevention, recovery (explanation only)

No code, branch or database changes. Points marked *(observed)* were checked in this repo's history; points marked *(platform behaviour)* describe how Lovable's sync works as far as its docs cover it. Anything the docs don't cover is marked *unconfirmed*.

## 1. Why it happens

- *(platform behaviour)* The sync runs both ways and follows one branch, `lovable` here. Every agent edit becomes a commit that is pushed to that branch. Every push to that branch on GitHub is pulled into Lovable.
- While the agent is working, its edits sit in the sandbox as a working copy on top of the last commit it pulled. They are only committed and pushed when the step or turn finishes.
- If a human push lands on `lovable` in the meantime, the agent's commit no longer fast-forwards onto the remote. Lovable does not merge or rebase it automatically. GitHub's `lovable` branch wins, and the sandbox is reset to that pushed state.
- "Replaced your Lovable work" means the sandbox and editor now show the human push, and the agent's in-flight edits are not in `lovable`. To avoid losing them, Lovable pushes them to a side branch, `lovable-sync-<unix time>`. That branch's parent is the old base, so your commit is not in its history, which matches what you saw.
- *Unconfirmed:* the exact moment within a turn when the check happens. The 1–3 minute gap after a human push matches the next commit attempt at the end of an agent step.
- *(observed)* Today's history interleaves bot commits with pushes from pius22, Chemayek Abraham and TimothyWaniayeChristian minutes apart, often while an agent run was going. The Receivables page "reverting" twice is the same thing: the edits went to a side branch and the screen showed the pushed version.

## 2. Habits that trigger it

1. Pushing to `lovable` while any agent run is active. This is the main trigger, and any push counts, even a clean fast-forward.
2. Several people pushing to `lovable` all day. Each push opens a new conflict window for whichever agent is running.
3. Force-pushes and rebases of `lovable`. These rewrite the base the agent started from, so the conflict is guaranteed and harder to recover from.
4. Merge commits pushed straight to `lovable`. These conflict the same way a normal push does, and they also make the recovery diff noisy.
5. Branches or local copies based on an old `lovable`. Changes from a stale base also bring back old files, as with the duplicated `buildPartnerReference` and the old Receivables page.

## 3. Ways to prevent it

1. **Humans don't push to `lovable` directly.** Each person works on their own branch (for example `dev/<name>`) and merges into `lovable` with a pull request.
2. **Merge only when no agent run is active.** Agree on a short "merge window" or a "Lovable busy" signal in your team chat. A merge during an active run is the same as a push.
3. **Which branch Lovable follows:** it follows the branch selected in the editor (Plus menu, then GitHub). The docs say branch switching in the editor is supported. You could point Lovable at a dedicated branch and merge humans' work into it on a schedule. *Unconfirmed:* whether this workspace's Git settings let you change it. Check in the GitHub panel.
4. **Protect `lovable` on GitHub.** Branch protection blocks force-pushes and requires pull requests. *Unconfirmed:* whether a "require PR" rule blocks Lovable's own pushes. Check that Lovable's GitHub App can still push before enforcing it.
5. **No supported setting to pause or lock sync, or to make Lovable pull before it commits** that I can confirm. Don't rely on one existing. If it matters, ask Lovable support.
6. **Before every push, get the latest `lovable` first** (`git fetch && git rebase origin/lovable`, or merge) so no stale files come back.

## 4. Recovering a `lovable-sync-*` branch

1. Locally, run `git fetch origin`, then `git log --oneline origin/lovable..origin/lovable-sync-<ts>` to see only the agent's lost commits.
2. Run `git diff origin/lovable...origin/lovable-sync-<ts>` (three dots) to see what the agent changed since the shared base.
3. Bring it into a fresh branch from the current `lovable`. Run `git switch -c recover-<ts> origin/lovable`, then `git cherry-pick <commits>`, or `git merge origin/lovable-sync-<ts>`. Resolve conflicts, then test.
4. Open a pull request into `lovable` and merge it during a quiet window.
5. Some side branches only hold work the agent has since redone, for example the Receivables full-width change, which was reapplied later. Compare with step 2, and skip the branch if `lovable` already has it.
6. **Deleting:** once a branch's changes are in `lovable` or knowingly dropped, it can be deleted on GitHub (`git push origin --delete lovable-sync-<ts>`). To check: `git branch -r --merged origin/lovable` lists the ones already merged. For the rest, the diff from step 2 should show nothing you need. Lovable doesn't use these branches after creating them. *Unconfirmed in the docs, but they are ordinary side branches.*

## 5. Recommendation for 4+ people pushing from outside Lovable

1. Lovable works only on `lovable`. Humans never push to it directly.
2. Each person works on their own branch from the latest `origin/lovable` and rebases on it daily.
3. Pull requests into `lovable`, with branch protection against force-pushes, and a required up-to-date check.
4. One person merges, in batches, at fixed times (for example 12:00 and 17:00 Kampala). Lovable chats pause during those times, and everyone gets the latest `lovable` after each batch.
5. After each batch, sweep the `lovable-sync-*` branches: recover or delete them using section 4.
6. Optional: a GitHub Action that posts to your team chat whenever a `lovable-sync-*` branch appears, so lost work is noticed at once.
