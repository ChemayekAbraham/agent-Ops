# 227 — Classifier prices bank payouts with the wallet-to-bank tariff (2026-10-14)

**Status: APPLIED BY HAND to production 2026-10-14 (Josh); migration file `20261014150000` committed afterwards to match.**

## Problem
Doc 225 put the bank tariff in `approve-withdrawal`, but `classify_merchant_payout_funding` (which owns the unattested claim rows) priced the telecom leg with `telecom_sending_charge()` (mobile-money 100-2,000). After doc 226 let bank payouts file claims, Immaculate's six bank payouts on 14 Oct carried telecom claims of 1,000-2,000 instead of 4,100-9,250 (9,500 filed vs 42,100). The classifier also capped the float telecom leg at the understated fee.

## Change
New `bank_sending_charge(numeric)` (same table as doc 225); classifier patched by string replace on the live definition; open bank claims from 14 Oct re-classified so the fees corrected.

## Verified
Six claims now 9,250 / 9,250 / 9,250 / 4,100 / 4,100 / 6,150; principals unchanged; a 7th payout (600,000) filed 6,150 correctly.

## Not changed
Other readers of the old tiers (`telecom_sending_charge`, `welile_telecom_sending_charge`, `merchant_telecom_sending_charge`, the daily report, UI call sites) still use the mobile-money fee for bank payouts.
