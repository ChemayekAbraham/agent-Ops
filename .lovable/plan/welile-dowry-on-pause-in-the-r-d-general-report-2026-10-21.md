# Welile Dowry "On pause" in the R&D General Report

## Goal

Welile Dowry is currently on pause. When the R&D dashboard's General report is extracted, the paused project is shown plainly with an "On pause" label — not highlighted, and not removed.

## What changes

1. `src/pages/rd/Dashboard.tsx`
   - Change Welile Dowry's stage from `Development` to `Paused` so the dashboard card and the report agree that it is paused.
   - Pass each project's stage into the report call (`exportReport`).

2. `src/lib/rdGeneralReportPdf.ts`
   - Accept an optional `stage` on each project and on cash rows.
   - Cash table: Welile Dowry's row reads "Welile Dowry (On pause)". Its figures stay in the table and in the totals. No special colour or emphasis on that row.
   - Project section: the heading for a paused project prints "Welile Dowry (On pause)" in plain text (normal dark colour) instead of the purple heading used for active projects. Its recorded updates still appear underneath.
   - Active projects are unchanged.

3. Paused is a setting in the project list. When Welile Dowry resumes, say the word and the label is removed in one small edit.

## Notes

- The report PDF itself does not colour negative figures today, so "not highlighted" here means: plain row, plain heading, no purple emphasis.
- The overlapping figures on the dashboard card (from your screenshot) are intentionally left alone for now.
- After approval I will first sync to `lovable` at 9eeef306ad (Neexa inbox push — no edits, no redeploy, no migration re-run, no UI) and confirm, then make these changes.

## Checks

- TypeScript typecheck and production build pass.
- Extract the General report and confirm the Welile Dowry row and heading read "(On pause)" with no highlight, while Welile Car and Welile School of AI stay as they are.
