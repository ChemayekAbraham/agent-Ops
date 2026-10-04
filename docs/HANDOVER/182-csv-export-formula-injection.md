# 182 — CSV exports: neutralise formula cells

## Status
**BUILT 2026-10-01, frontend only.** `src/lib/csvExport.ts` + new test `src/lib/csvExport.test.ts` (4 tests, pass). No migration, no edge function.

## Problem
`downloadCsv` quoted every field but did nothing about cells that open with `=`, `+`, `-` or `@`. Excel and Sheets run those as formulas. Several exports carry user-influenced text (client error messages in the Agent Collections monitor CSV added in PR #9, names, notes), so a crafted value such as `=HYPERLINK(...)` would execute when a finance or ops user opens the file. The helper is the single choke point for about 20 call sites in 20 files (37 `downloadCsv(` calls).

## Change
New exported `csvCell`. For STRING values that start with `= + - @` (or tab / CR), it prefixes an apostrophe so the cell opens as text (OWASP CSV-injection guidance). Left alone:
- real `number` values (a negative amount stays `-5000`);
- numeric-looking strings, phones and percentages: `-5,000`, `+256700000000`, `-12.5%`, `(1,200)`, `-5000 UGX`;
- the lone placeholder `-`.

## Trade-off
A formula-looking string now shows a leading `'` in the opened file. That is the accepted cost. A value like `-5000 UGX` is treated as numeric on purpose; a string with an operator after the digits (`-2+3`) is treated as a formula.

## Verify
`npx vitest run src/lib/csvExport.test.ts`. After deploy, export any CSV that contains a phone or negative amount (e.g. the cash movement report) and confirm those cells are unchanged.

## Not changed
No caller. The audit-log insert in `downloadCsv` is unchanged.

## Architecture map
No update: a helper-level escape, no new subsystem.
