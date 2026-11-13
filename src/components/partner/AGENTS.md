# Partner component decisions
- Pre-portfolio agreement rates are server-approved before countersigning; send the confirmed rate to the atomic preparation call so the executed PDF and new portfolio match.
- Partner self-support amounts use `useSelfSupportFeePolicy().pay` (identity for sort/filter) to match server `self_support_gross`.
- A funded Rent Plan's landlord phone, mobile money, tenant agreement, funding timeline and receipt come from `FunderVerifiedPlanPack` (`funder_verified_rent_plan_dossier`). The list payload's landlord phone is not shown.
