# src/lib decisions
- R&D report exports accept project names, dated recorded updates, current editable cash and freshly fetched saved idea canvases; failed idea reads block incomplete exports, while cash persists on explicit edits to prevent reload overwrites.
- R&D project cash metrics resolve from editable cash rows by stable row ID, never preset values or editable names, so edits update metrics without stale fallbacks.
- R&D project cards, weekly report and exports share one recorded-update state persisted on explicit edits; weekly periods use non-overlapping Kampala calendar days to avoid preset evidence and divergent report copies.
