# 184 — Email Transactions: MTN MoMo / Airtel Money / Bank filters

**BUILT 2026-10-01, frontend only (hook).** No migration, no edge function.

`useEmailTransactionsPanel.ts` gets a persisted `channelFilter`
(`all | mtn_momo | airtel_money | bank`, localStorage `gmail_filter_channel`),
applied in `visibleRows` via `ch(r).channel` (parser channel, else the derived
channel, so unparsed-channel rows still sort correctly). Three new entries in
`gmailLabels` (label rail, no JSX change) with counts from `gmailLabelCounts`
(`mtn`, `airtel`, `bank`). They stack with Money in/out and status labels;
clicking an active channel clears it; Inbox resets it. 30-day mix: airtel 1511,
mtn 817, bank 97, other 124 ("other" has no filter yet).

Not changed: label counts for in/out/status ignore the channel filter. Filter
presets don't snapshot the channel. Visual polish of the new labels = Gemini.
architecture-map.html not updated: no subsystem or flow changed.
