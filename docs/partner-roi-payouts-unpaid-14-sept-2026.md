# Partner ROI payouts raised 14 September 2026 — still unpaid

**Status as at 15 September 2026.** Every row below is a Returns payout that was
requested on 14 September and has **not been paid**. No payment reference,
payout code or payment proof exists on any of them, because no payment was ever
made. Nothing is missing from the record — there is no transaction yet.

The Mobile Money Transaction ID column reads blank throughout, but that column
is blank on *every* withdrawal in the system, paid or not. See the notes at the
end.

| | |
| --- | ---: |
| Partners awaiting payment | **82** |
| Total owed | **UGX 56,193,180** |
| Bank Transfer | 51 payouts — UGX 43,700,125 |
| Mobile Money | 31 payouts — UGX 12,493,055 |
| All requested by | Kabahuma Lillian (proxy agent) |
| Requested between | 14 Sep 2026, 13:27 – 13:43 EAT |
| Approvals recorded | **none** — no manager, CFO, COO or Financial Ops stamp on any row |

## Why they were not paid

Three migrations went live that morning which hid a withdrawal from merchant
cash-out agents unless the owner had a Financial-Ops-verified payout
destination — the National ID and selfie workflow built for agents and
merchants.

| Time (EAT) | Event |
| --- | --- |
| 10:22 | Withdrawals hidden from merchant agents unless the owner is ID-verified |
| 10:26 | Merchant claim and auto-dispatch gated on the same test |
| 10:30 | Claim additionally requires ID + selfie submitted |
| **10:32:58** | First `id_not_verified` claim refusal ever recorded |
| 13:27–13:43 | The 83 payouts below were raised into a pipeline that could no longer see them |
| 13:33 | Last ordinary (non-partner) payout of the day |
| 15:57 | A one-off exemption was written for the proxy agent |
| 16:27 | LYDIA KUZAALA paid — UGX 2,105,984, the only one of the batch |
| 16:46 | A partner holding a portfolio now counts as ID-verified (the real fix) |

Partners are investors; they never go through merchant ID verification. **846
partners hold portfolios and only 10 had a verified payout destination**, so
98.8% of them failed the test the moment it went live.

The gate hid the rows before it refused them, which is why almost no failures
were logged: there was nothing on screen to click.

**The block is already cleared in code.** All 82 now pass the verification test.
They remain unpaid only because the batch has not been re-worked since the fix
landed on Monday afternoon.

## The 82 partners

ROI % and principal are the partner's portfolio terms. "ROI due" is the amount
the payout was raised for.

| # | Partner | Portfolio | ROI % | Principal (UGX) | ROI due (UGX) | Requested | Method | Destination | Txn ID |
| ---: | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |
| 1 | OLWENY INNOCENT MAKOLAS | WIP2602129749 | 15% | 25,000,000 | **3,750,000** | 14 Sep 2026 13:34 | Bank Transfer | CENTENARY BANK 3202699794 — OLWENY INNOCENT | (blank) |
| 2 | Erias Walugembe | WIP2608126003 | 15% | 20,000,000 | **3,000,000** | 14 Sep 2026 13:43 | Bank Transfer | Bank of Africa 09341010017 — Walugembe Erias | (blank) |
| 3 | Nangoli Phillip | WIP2607147763 | 15% | 20,000,000 | **3,000,000** | 14 Sep 2026 13:31 | Mobile Money | MTN 0789835748 — ACCOUNT 1 | (blank) |
| 4 | KIPLANGAT CALEB | WIP2603122110 | 20% | 16,000,000 | **2,400,000** | 14 Sep 2026 13:34 | Bank Transfer | EQUITY BANK 1046103506894 — KIPLANGAT CALEB | (blank) |
| 5 | PAMELA SSAKA | WIP2607146018 | 15% | 15,000,000 | **2,250,000** | 14 Sep 2026 13:30 | Bank Transfer | STANDARD CHATTERED BANK 0100819018100 — pamela ssaka | (blank) |
| 6 | MAGEMESO ELVIS | WIP2606151939 | 20% | 10,600,000 | **2,120,000** | 14 Sep 2026 13:33 | Bank Transfer | EQUITY BANK 1021103504273 — MAGEMESO ELVIS | (blank) |
| 7 | AGABA COLLINS | WIP2511125658 | 15% | 14,000,000 | **2,100,000** | 14 Sep 2026 13:33 | Bank Transfer | STANDARD CHATTERED BANK 0151321063300 — AGABA COLLINS | (blank) |
| 8 | MARY GORRETTI ASIRE | WIP2605139847 | 15% | 14,000,000 | **2,100,000** | 14 Sep 2026 13:42 | Bank Transfer | CENTENARY BANK 3203368509 — MARY GORRETI ASIRE | (blank) |
| 9 | NAMPIIMA RUTH | WIP2602114996 | 15% | 20,000,000 | **2,100,000** | 14 Sep 2026 13:40 | Bank Transfer | EQUITY BANK 1049103550665 — NAMPIIMA RUTH | (blank) |
| 10 | BUULE JOSHUA | WIP2606122868 | 20% | 8,000,000 | **1,600,000** | 14 Sep 2026 13:42 | Bank Transfer | EQUITY BANK 1044102214601 — FLORENCE NAMAGANDA | (blank) |
| 11 | ANGEL NAKAYIZA KIRUNDA | WIP2602121626 | 15% | 10,000,000 | **1,500,000** | 14 Sep 2026 13:35 | Bank Transfer | ABSA BANK 6002797621 — ANGEL NAKAYIZA KIRUNDA | (blank) |
| 12 | KISAKYE RUTH LUNKUSE | WPF-7675 | 15% | 10,000,000 | **1,500,000** | 14 Sep 2026 13:36 | Bank Transfer | STANBIC BANK 9030021541841 — KISAKYE RUTH LUNKUSE | (blank) |
| 13 | VICTORIA ADAH TEGA | WIP2606156376 | 15% | 10,000,000 | **1,500,000** | 14 Sep 2026 13:42 | Bank Transfer | STANBIC BANK 9030013176859 — VICTORIA TEGA | (blank) |
| 14 | Mbakureeba Joshua | WIP2607231285 | 15% | 7,900,000 | **1,185,000** | 14 Sep 2026 13:31 | Bank Transfer | EQUITY BANK 1046101955161 — MBAKUREEBA JOSHUA | (blank) |
| 15 | OCANA JAMES | WIP2603114994 | 15% | 7,500,000 | **1,125,000** | 14 Sep 2026 13:40 | Bank Transfer | CENTENARY BANK 3203601282 — OCANA JAMES | (blank) |
| 16 | Jessica Kitaka | WIP2606156139 | 15% | 7,350,000 | **1,102,500** | 14 Sep 2026 13:42 | Mobile Money | AIRTEL 0756129547 — ACC 1 | (blank) |
| 17 | Lutaaya Richard | WPF-1218 | 15% | 7,000,000 | **1,050,000** | 14 Sep 2026 13:30 | Bank Transfer | CENTENARY BANK 3202627763 — LUTAAYA RICHARD | (blank) |
| 18 | MUYANJA MOSES | WIP2603154134 | 15% | 7,000,000 | **1,050,000** | 14 Sep 2026 13:29 | Bank Transfer | EQUITY BANK 1035100578775 — MUYANJA MOSES | (blank) |
| 19 | IRENE NAMWEBYA | WIP2602126173 | 15% | 6,700,000 | **1,005,000** | 14 Sep 2026 13:35 | Mobile Money | AIRTEL 0704815630 — IRENE NAMWEBYA | (blank) |
| 20 | OTAFIRE BRIAN KING | WIP2601119656 | 15% | 6,100,000 | **915,000** | 14 Sep 2026 13:39 | Mobile Money | MTN 0780109876 — OTAFIRE BRIAN KING | (blank) |
| 21 | CHELIMO PRISCILLAR | WIP2603305218 | 15% | 6,050,000 | **907,500** | 14 Sep 2026 13:41 | Bank Transfer | CENTENARY BANK 4920006529 — CHELIMO PRISCILLAR CHEROP | (blank) |
| 22 | BALINDA SASMON | WIP2508133430 | 15% | 6,000,000 | **900,000** | 14 Sep 2026 13:31 | Bank Transfer | EQUITY BANK 1036103589256 — BALINDA SASMON, DANIEL LELEI, DAVID, IAN | (blank) |
| 23 | SIMON MUWONGE | WIP2608144501 | 15% | 6,000,000 | **900,000** | 14 Sep 2026 13:32 | Mobile Money | AIRTEL 0752692920 — simon muwonge | (blank) |
| 24 | ARAPWONGE ISAAC | WIP2602114671 | 15% | 5,500,000 | **825,000** | 14 Sep 2026 13:40 | Bank Transfer | CENTENARY BANK 3201884913 — ARAPWONGE ISAAC | (blank) |
| 25 | Kibet Daniel | WIP2604149235 | 15% | 5,350,000 | **802,500** | 14 Sep 2026 13:29 | Bank Transfer | PEARL BANK 1030032003602 — KIBET DANIEL | (blank) |
| 26 | NAKAMYA PHIONAH | WIP2607088287 | 15% | 5,000,000 | **750,000** | 14 Sep 2026 13:30 | Bank Transfer | FINANCE TRUST BANK 300225001774 — NAKAMYA PHIONA | (blank) |
| 27 | NINSIIMA SHAKILLAH KIMOTE | WIP2603166369 | 20% | 3,500,000 | **700,000** | 14 Sep 2026 13:34 | Bank Transfer | STANBIC BANK 9030016558086 — SHAKILAH NINSIIMA | (blank) |
| 28 | yaseen kc💎 | WIP2606046538 | 20% | 3,399,200 | **679,840** | 14 Sep 2026 13:41 | Mobile Money | AIRTEL 0747232577 — bukenya yaseen ssebunya | (blank) |
| 29 | NASSANGA WINNIE | WIP2603183450 | 15% | 4,017,500 | **602,625** | 14 Sep 2026 13:34 | Bank Transfer | EQUITY BANK 1038101248686 — NASSANGA WINNIE | (blank) |
| 30 | Mwesigye Micheal Kataama | WIP2607129580 | 15% | 4,000,000 | **600,000** | 14 Sep 2026 13:38 | Mobile Money | AIRTEL 0701968852 — ACCOUNT 1 | (blank) |
| 31 | NAKATO HARRIET | WIP2606112849 | 15% | 4,000,000 | **600,000** | 14 Sep 2026 13:43 | Bank Transfer | DFCU BANK 01440016713840 — NAKATO HARRIET | (blank) |
| 32 | NIWOMUTAMBI MERCY | WIP2603122223 | 15% | 4,000,000 | **600,000** | 14 Sep 2026 13:36 | Bank Transfer | EQUITY BANK 1045102701459 — NIWOMUTAMBI MERCY | (blank) |
| 33 | WAKABI SIMON PETER | WIP2603252708 | 15% | 4,000,000 | **600,000** | 14 Sep 2026 13:28 | Bank Transfer | EQUITY BANK 1046102391304 — WAKABI SIMION PETER | (blank) |
| 34 | PHIONA NANYONJO | WIP2603049746 | 20% | 2,500,000 | **500,000** | 14 Sep 2026 13:40 | Mobile Money | MTN 0782847917 — NANYONJO PHIONA | (blank) |
| 35 | Erias Walugembe | WIP2607147902 | 15% | 3,000,000 | **450,000** | 14 Sep 2026 13:30 | Bank Transfer | CENTENARY BANK 3200357800 — ERIAS WALUGEMBE | (blank) |
| 36 | NAKANWAGI RITAH L | WIP2602116079 | 15% | 3,000,000 | **450,000** | 14 Sep 2026 13:40 | Bank Transfer | CENTENARY BANK 3201987552 — NAKANWAGI RITAH LILIAN | (blank) |
| 37 | NAKAWUMA CHRISTINE | WIP2608137410 | 15% | 3,000,000 | **450,000** | 14 Sep 2026 13:39 | Bank Transfer | EQUITY BANK 1025102699613 — NAKAWUMA CHRISTINE | (blank) |
| 38 | NAMONO SALAAMA | WIP2603133082 | 15% | 3,000,000 | **450,000** | 14 Sep 2026 13:29 | Bank Transfer | CENTENARY BANK 3203975067 — NAMONO SALAAMA | (blank) |
| 39 | NDUGGA JOSEPH | WIP2603126136 | 15% | 3,000,000 | **450,000** | 14 Sep 2026 13:35 | Bank Transfer | CENTENARY BANK 3200342516 — NDUGGA JOSEPH | (blank) |
| 40 | PATIENCE LILIAN ATUHAIRE | WIP2603068150 | 20% | 2,000,000 | **400,000** | 14 Sep 2026 13:28 | Mobile Money | MTN 0787238712 — ATUHAIRE PATIENCE LILIAN | (blank) |
| 41 | achomo Winnie | WIP2608121664 | 15% | 4,900,000 | **390,000** | 14 Sep 2026 13:32 | Mobile Money | MTN 0779802600 — achomo Winnie | (blank) |
| 42 | MUTELA JACOB | WIP2601128565 | 15% | 2,200,000 | **330,000** | 14 Sep 2026 13:34 | Mobile Money | MTN 0777375727 — MUTELA JACOB | (blank) |
| 43 | NAKAWUMA CHRISTINE | WIP2607148672 | 15% | 2,100,000 | **315,000** | 14 Sep 2026 13:31 | Bank Transfer | EQUITY BANK 1025102699613 — NAKAWUMA CHRISTINE | (blank) |
| 44 | Deborah Mukisa | WIP2606156296 | 15% | 2,000,000 | **300,000** | 14 Sep 2026 13:43 | Mobile Money | MTN 0786438375 — DEBORAH MUKISA | (blank) |
| 45 | Doreen Muhawe | WPF-2992 | 15% | 2,000,000 | **300,000** | 14 Sep 2026 13:43 | Bank Transfer | EQUITY BANK 1036103718706 — DOREEN MUHAWE BYORO | (blank) |
| 46 | MUHWEEZI BONNY | WIP2508134391 | 15% | 2,000,000 | **300,000** | 14 Sep 2026 13:28 | Bank Transfer | EQUITY BANK 1040102899827 — MUHWEZI BONNY | (blank) |
| 47 | NAMBUYA ESTHER | WIP2612047880 | 15% | 2,000,000 | **300,000** | 14 Sep 2026 13:41 | Bank Transfer | CENTENARY BANK 3201866836 — NAMBUYA ESTHER | (blank) |
| 48 | NASSANGA WINNIE | WIP2608137480 | 15% | 2,000,000 | **300,000** | 14 Sep 2026 13:39 | Bank Transfer | EQUITY BANK 1038101248686 — NASSANGA WINNIE | (blank) |
| 49 | SSEBUUMA ARNOLD | WIP2607133336 | 15% | 2,000,000 | **300,000** | 14 Sep 2026 13:37 | Bank Transfer | CENTENARY BANK 3200691776 — SSEBUUMA ARNOLD MUGAGA | (blank) |
| 50 | VICENT KATO | WIP2607147609 | 15% | 2,000,000 | **300,000** | 14 Sep 2026 13:30 | Bank Transfer | BANK OF BARODA 95130100002378 — KATO VICENT | (blank) |
| 51 | NAKAWUMA CHRISTINE | WIP2608137574 | 15% | 1,600,000 | **240,000** | 14 Sep 2026 13:39 | Bank Transfer | EQUITY BANK 1025102699613 — NAKAWUMA CHRISTINE | (blank) |
| 52 | NAKAYIMA VERONICA | WIP2506124182 | 15% | 1,500,000 | **225,000** | 14 Sep 2026 13:38 | Mobile Money | AIRTEL 0754338755 — NAKAYIMA VERONICA | (blank) |
| 53 | ROBERT MUKUYE | WIP2601112619 | 15% | 1,500,000 | **225,000** | 14 Sep 2026 13:39 | Mobile Money | MTN 0790499492 — MUKUYE ROBERT | (blank) |
| 54 | Tidah Nnamakula | WPF-2599 | 15% | 1,350,000 | **202,500** | 14 Sep 2026 13:37 | Bank Transfer | PRIDE BANK 221205024673101 — TIDAH NAMAKULA | (blank) |
| 55 | MUTESI ESTHER | WIP2504137421 | 20% | 1,000,000 | **200,000** | 14 Sep 2026 13:28 | Mobile Money | MTN 0788267967 — MUTESI ESTHER | (blank) |
| 56 | Frida Wangare | WIP2608171465 | 15% | 1,130,000 | **169,500** | 14 Sep 2026 13:32 | Mobile Money | MTN 0761286566 — kalule wilberforce | (blank) |
| 57 | BALINDA SASMON | WIP2608122465 | 15% | 1,000,000 | **150,000** | 14 Sep 2026 13:43 | Bank Transfer | HOUSING FINANCE 1060000089628 — BALINDA SASMON | (blank) |
| 58 | CHELANGAT LINOS | WIP2602113054 | 15% | 1,000,000 | **150,000** | 14 Sep 2026 13:40 | Mobile Money | MTN 0777354170 — CHELANGAT LINOS | (blank) |
| 59 | Chemutai Mark | WIP2607132670 | 15% | 1,000,000 | **150,000** | 14 Sep 2026 13:38 | Bank Transfer | EQUITY BANK 1044103730829 — CHEMUTAI MARK | (blank) |
| 60 | EDDIE SAKWA | WIP2608121055 | 15% | 1,000,000 | **150,000** | 14 Sep 2026 13:33 | Mobile Money | AIRTEL 0701103326 — EDDIE SAKWA | (blank) |
| 61 | KATO KIYINGI ALLAN | WIP2603129841 | 15% | 1,000,000 | **150,000** | 14 Sep 2026 13:35 | Bank Transfer | EQUITY BANK 1034103280728 — KATO KIYINGI ALLAN | (blank) |
| 62 | Mirembe Doreen | WIP2606157217 | 15% | 1,000,000 | **150,000** | 14 Sep 2026 13:37 | Mobile Money | MTN 0779154498 — ACC 1 | (blank) |
| 63 | MUSENE MOSES | WIP2604124011 | 15% | 1,000,000 | **150,000** | 14 Sep 2026 13:36 | Bank Transfer | ABSA BANK 6002887094 — MUSENE MOSES | (blank) |
| 64 | MWOGERE SUSAN MARY | WIP2603112818 | 15% | 1,000,000 | **150,000** | 14 Sep 2026 13:41 | Bank Transfer | EQUITY BANK 1046103493049 — MWOGERE SUSAN MARY | (blank) |
| 65 | NABATTE JOSEPHINE | WIP2608119490 | 15% | 1,000,000 | **150,000** | 14 Sep 2026 13:31 | Bank Transfer | EQUITY BANK 1052103340049 — JOSEPHINE NABATTE | (blank) |
| 66 | NAKANWAGI RITAH L | WIP2605138720 | 15% | 1,400,000 | **150,000** | 14 Sep 2026 13:41 | Mobile Money | MTN 0757678169 — NAMUGUMYA RACHEAL | (blank) |
| 67 | NAKIMBUGWE MADRINE | WIP2607147061 | 15% | 1,000,000 | **150,000** | 14 Sep 2026 13:38 | Bank Transfer | CENTENARY BANK 32047962730 — MUGISHA OLIVER | (blank) |
| 68 | Nankumba Grace | WIP2608128761 | 15% | 1,000,000 | **150,000** | 14 Sep 2026 13:33 | Mobile Money | AIRTEL 0751430686 — NANKUMBA GRACE | (blank) |
| 69 | YEYERI DIANA BOMA | WIP2603114075 | 15% | 1,000,000 | **150,000** | 14 Sep 2026 13:41 | Mobile Money | MTN 0788671176 — YAYERI DIANA BOMA | (blank) |
| 70 | ian besiga | WPF-5718 | 20% | 700,000 | **140,000** | 14 Sep 2026 13:36 | Mobile Money | AIRTEL 0701926648 — ACC 1 | (blank) |
| 71 | MULUNGI GLORIOUS BLESSINGS | WIP2604116473 | 15% | 830,000 | **124,500** | 14 Sep 2026 13:41 | Mobile Money | MTN 0795216695 — GLORIOUS BLESSINGS MULUNGI | (blank) |
| 72 | Ponsiano Migano | WIP2607131058 | 15% | 700,000 | **105,000** | 14 Sep 2026 13:37 | Mobile Money | AIRTEL 0758422559 — ACCOUNT 1 | (blank) |
| 73 | Keith Asea | WIP2607131944 | 20% | 500,000 | **100,000** | 14 Sep 2026 13:37 | Mobile Money | AIRTEL 0751633328 — ACCOUNT 4 | (blank) |
| 74 | NAMAYANJA IMMECULATE | WIP2604133509 | 15% | 666,434 | **99,965** | 14 Sep 2026 13:39 | Mobile Money | AIRTEL 0706058538 — NAMANTOVE JANE | (blank) |
| 75 | Dansan Chepkurui | WIP2608143200 | 15% | 500,000 | **75,000** | 14 Sep 2026 13:27 | Bank Transfer | STANBIC BANK 9030020413599 — DANSAN CHEPKURUI | (blank) |
| 76 | Steven Angao | WIP2606125868 | 15% | 500,000 | **75,000** | 14 Sep 2026 13:43 | Bank Transfer | STANDARD CHATTERED BANK 0100268245300 — STEVEN ANGAO JACKSON | (blank) |
| 77 | NAKAWUMA CHRISTINE | WIP2606126024 | 15% | 400,000 | **60,000** | 14 Sep 2026 13:42 | Bank Transfer | EQUITY BANK 1025102699613 — NAKAWUMA CHRISTINE | (blank) |
| 78 | MATTHEW Biosyn.ai MULINDWA | WIP2608125530 | 15% | 200,000 | **30,000** | 14 Sep 2026 13:33 | Mobile Money | AIRTEL 0744946641 — MULINDWA MATTHEW | (blank) |
| 79 | Amase Stisha Margret | WIP2607136239 | 15% | 130,000 | **19,500** | 14 Sep 2026 13:38 | Mobile Money | AIRTEL 0752348951 — ACCOUNT 1 | (blank) |
| 80 | Monic Momo Nankunda | WIP2608138655 | 15% | 115,000 | **17,250** | 14 Sep 2026 13:32 | Mobile Money | AIRTEL 0742202521 — ACCOUNT 1 | (blank) |
| 81 | Kiplimo Emmanuel Mzee | WIP2608138580 | 15% | 100,000 | **15,000** | 14 Sep 2026 13:32 | Mobile Money | MTN 0770455999 — CHEMUTAI FAITH | (blank) |
| 82 | Raymond Wampamba Nkoola | WPF-0886 | 15% | 100,000 | **15,000** | 14 Sep 2026 13:37 | Bank Transfer | EQUITY BANK 1001103405154 — WAMPAMBA RAYMOND NKOOLA | (blank) |

**Total — UGX 56,193,180 across 82 partners.**

## Paid from the same batch

One payout of the 83 was completed, 30 minutes after a one-off exemption was
written for the proxy agent. It is listed here for completeness and is **not**
counted in the 82 above.

| Partner | Portfolio | ROI due (UGX) | Paid | Method | Payment ref |
| --- | --- | ---: | --- | --- | --- |
| LYDIA KUZAALA | IMMY AND LYDIA | 2,105,984 | 14 Sep 2026 16:27 | Mobile Money — AIRTEL 0759743760 | 43506250986 |

Note that 43506250986 is her **Financial Ops reference**, not a Mobile Money
transaction ID — see below.

## Notes

- **The Mobile Money Transaction ID is blank — but not for the reason you
  might expect.** The `transaction_id` column is dead: across **2,105
  withdrawals completed in the last 30 days it is NULL on every single one**,
  while `fin_ops_reference` is filled on all 2,105. The payment reference
  Financial Ops actually records lives in `fin_ops_reference`. So this column
  would read blank even if these 82 had been paid — it is blank on LYDIA
  KUZAALA's completed payout too.
- What *is* missing on the 82 because they were never paid: `fin_ops_reference`,
  `payout_code` and `payout_proof_path` are all empty, and no approval stamp of
  any kind exists on any row.
- Where the destination account name differs from the partner's own name, that
  is what is on file against the portfolio. Worth checking before paying.
- Some partners appear more than once because they hold more than one
  portfolio: NAKAWUMA CHRISTINE (4), Erias Walugembe (2), BALINDA SASMON (2),
  NASSANGA WINNIE (2), NAKANWAGI RITAH L (2).
- **None of these 82 partners has been told a withdrawal exists in their name.**
  The proxy withdrawal path sends no notification at submission — no email, no
  SMS, no in-app notice. The Returns receipt is only sent once a payment is
  actually made.
