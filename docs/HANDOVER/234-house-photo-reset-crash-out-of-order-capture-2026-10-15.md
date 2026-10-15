# 234 — House-photo reset crashed when photos were taken out of slot order (2026-10-15)

**Status:** code committed on `dev/cto-report-sms-balance-watch`; not yet merged to `lovable` or deployed.

## Symptom
One row in `agent-collection-errors-all-7d-20261015-0921.csv` (iPhone, Denis Tushabe, 10-14 15:39 UTC): `TypeError: undefined is not an object (evaluating 't.preview')`, stack `forEach` inside `AgentRentRequestDialog`.

## Cause
`housePhotos` is indexed by slot (front, back, left, right). `attachPhoto` does `next[index] = {...}` on a copy. Taking slot 4 before slot 1 leaves holes, and the next `[...prev]` turns the holes into real `undefined` entries. The dialog's reset then ran `housePhotos.forEach(p => URL.revokeObjectURL(p.preview))` and threw on the first `undefined`.

## Fix
`AgentRentRequestDialog.tsx` reset now skips empty entries (`if (p)`). One line of logic; JSX untouched. Every other reader uses `housePhotos[i]` truthiness or runs after validation has confirmed all four slots.

## Not changed, worth knowing
`removePhoto` uses `splice`, so removing slot 1 shifts slot 2 into slot 1's position and its front/back/left/right label. That is a behaviour question for Josh and Gemini, not a crash, and not in this export.

## Closing the export
With docs 231–234 every row of the 7-day export is accounted for: 165 `randomUUID` (fixed, 231), 4 allocate (all landed, 232), 4 lazy-chunk/unhandled (stale bundles, 233), 1 `t.preview` (this doc).
