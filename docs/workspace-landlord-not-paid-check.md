# Landlord not paid: 6 plans the old Workspace counted as owing

Checked 2026-10-12 against the live database. Read-only: no plan, payout or allocation was changed.

The old Tenant Operations Workspace started counting each of these Rent Plans on the day the tenant confirmed the payment code. The landlord payout for every one of them is `failed`, so no landlord payout was ever counted as paid. The shared clock (`am_plan_clock`, also used by Agent Monitoring) counts a plan only from the day after a payout reaches `awaiting_agent_receipt` or `completed`. These plans now sit under "Landlord not paid yet" and are not counted as owing.

Operations to call each landlord and confirm whether the rent was received.

| Tenant | Agent | Landlord | Landlord phone | Rent amount (UGX) | Payout status | Payment code confirmed (Kampala) |
|---|---|---|---|---|---|---|
| KAKOOZA MUZAFALU | OACAR ARNOLD (+256730328173) | Kasule Abey | 0752804468 | 0 (see note) | failed, failed (2 attempts of 600,000) | 2026-05-15 14:02 |
| Babirye betty | Eric Natamba (no phone on file) | Nabukenya frank | 0746095200 | 400,000 | failed | 2026-05-19 11:52 |
| Nanyonga Mariam | Mugisha Emmanuel (+256701362653) | Nabbosa Henrietta | 0705654174 | 1 (see note) | failed (200,000) | 2026-05-28 12:31 |
| Nakasinde Harriet | Joshua Kisakye (+256794834172) | Miyingo Godfry | 0752307844 | 500,000 | failed | 2026-06-11 12:23 |
| Namusosa Esther | FRED MUWANGUZI (+256708778540) | Muwumba rose | 0779599183 | 150,000 | failed | 2026-09-17 14:53 |
| Kalange Muhammad | Mukisa juli (+256707911662) | Namata Immaculate | 0742215946 | 200,000 | failed | 2026-09-17 16:14 |

Plan ids: KAKOOZA MUZAFALU `f95739fc-84e2-4113-ab45-f6acc08360df`, Babirye betty `3735a62d-13f9-41ae-9506-72ad3c477cc9`, Nanyonga Mariam `ccace68a-b552-4fcd-beed-76a02f035aea`, Nakasinde Harriet `01497e18-2ec8-4887-bd9e-b408c5a06c85`, Namusosa Esther `40a393bf-84db-49fa-acd8-652cbf1223cd`, Kalange Muhammad `5d2fc34c-c02f-453d-b754-f8c43bf904c0`.

## Notes

- The old Workspace clock start for each plan was the date in the last column (same day), e.g. 2026-05-15 for KAKOOZA MUZAFALU. None of these plans has any built instalments or settlements in the old tables.
- Nanyonga Mariam's float allocation shows `fully_paid: 200000` even though the payout is `failed`. Worth asking the landlord whether the money reached them by another route.
- Two plans carry a rent amount of 0 and 1. These look like data-entry problems, separate from the payout question.
- This file holds landlord phone numbers for the callback. Don't share it outside Operations.
