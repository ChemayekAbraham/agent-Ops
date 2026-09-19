# Combine Cash at Hand and Bank

## Change
- Group ledger accounts A1 (bank cash) and A5 (cash in custody/not yet confirmed banked) into one asset row named **Cash at Hand and Bank**.
- Remove the separate **Cash in Custody — Not Yet Confirmed Banked** row so the amount appears only once.
- Preserve both underlying account lines in the tap-to-open breakdown, making the combined total traceable.
- Keep Total Assets unchanged because this is presentation grouping only; no ledger, wallet, database, or policy changes.

## Verification
- Confirm the combined row equals A1 + A5 and the modal shows both exact amounts.
- Confirm Total Assets and the balance check are unchanged.
- Run the project safeguards and check the preview build.
