# Rent Plans stuck at `funded` - never billed to anyone

Generated 2026-10-20 from production.

These plans are past their term end and still owe money, but their status never moved
from `funded` to `repaying`. `pin_agent_expected_day` bills only `repaying` plans, so
none of these has ever appeared on an agent's daily bill. Nobody is being asked to
collect them.

## Summary

| | |
|---|---:|
| Plans | **40** |
| Still owed | **UGX 15,606,770** |
| Landlord WAS paid | 19 plans, UGX 8,963,421 owed |
| Landlord NOT paid / no record | 21 plans, UGX 6,643,349 owed |
| Never received a single collection | 39 plans |
| Oldest overdue | 193 days |

**The landlord-paid split is what to act on.** Where the landlord was paid, the money
went out and the tenant genuinely owes it - collectable, simply unbilled. Where the
landlord was never paid, the tenant may owe nothing, and billing them would be wrong.

## Landlord was paid - collectable, just unbilled

| Tenant | Agent | Landlord | Owed | Funded | Term ended | Days over | Collections |
|---|---|---|---:|---|---|---:|---:|
| Mbonimpa Emmanuel | GRACE PAUL OCHIENG | Godfrey  lubega | 1,217,000 | 2026-08-13 | 2026-09-12 | 38 | 0 |
| Evans Kalaba Mugerwa | GRACE PAUL OCHIENG | MAPENDO ELISHA | 1,084,000 | 2026-09-17 | 2026-10-18 | 2 | 0 |
| Wamuti Edrine | Zinc | Maimuna Nambi | 818,000 | 2026-05-15 | 2026-06-14 | 128 | 0 |
| Namutebi Phiona | MICHAEL OKWAKOL | wamwera abdul | 727,560 | 2026-07-14 | 2026-09-14 | 36 | 0 |
| Nakanwagi Noelina Mary | MICHAEL OKWAKOL | Saudah Namiiro | 727,560 | 2026-07-02 | 2026-08-31 | 50 | 0 |
| Naigaga Zaina | amase rosemary | Namulinda merab | 685,000 | 2026-08-11 | 2026-09-17 | 33 | 0 |
| Alex Kawadwa | Nalubiri Angel | ssemakula karim | 538,700 | 2026-09-10 | 2026-10-10 | 10 | 0 |
| Kabuye Sulaiman | (unassigned) | faridah nakito | 419,000 | 2026-07-09 | 2026-08-08 | 73 | 0 |
| Lubega John | (unassigned) | kambagira paul | 419,000 | 2026-07-16 | 2026-08-15 | 66 | 0 |
| nakugude annet | maasa mubakal | namakoye jennifer | 419,000 | 2026-07-29 | 2026-08-29 | 52 | 0 |
| Namaganda Eseza | maasa mubakal | Otim David | 419,000 | 2026-07-16 | 2026-08-20 | 61 | 0 |
| Akansasira Judith | GVEN AKANDWANAHO | Byansi Amos | 385,000 | 2026-07-21 | 2026-08-20 | 61 | 0 |
| Kilama Emmanuel | Mugisha Emmanuel | Tony Balondemu | 276,000 | 2026-07-07 | 2026-08-06 | 75 | 0 |
| KIZITO ABEL | Kwenseri Rodgers | Magala Herbert | 271,900 | 2026-06-18 | 2026-07-19 | 93 | 1 |
| Test Tenant 164 | JOSHUA WANDA | Test Landlord 473 | 209,500 | 2026-04-20 | 2026-06-12 | 130 | 0 |
| Mr Brian Byamugisha | Joshua Kisakye | Diligenda Noah | 143,000 | 2026-05-15 | 2026-07-11 | 101 | 0 |
| Ssebaduka Betty | GVEN AKANDWANAHO | byansi amos | 139,000 | 2026-07-23 | 2026-08-22 | 59 | 0 |
| Yaseen Kc💎 | Yaseen Kc💎 | yaseen kc | 55,200 | 2026-05-13 | 2026-10-15 | 5 | 0 |
| Nanyonga Mariam | Mugisha Emmanuel | Nabbosa Henrietta | 10,001 | 2026-05-15 | 2026-06-14 | 128 | 0 |

## Landlord NOT paid, or no payout record - verify before collecting

| Tenant | Agent | Landlord | Owed | Funded | Term ended | Days over | Allocation |
|---|---|---|---:|---|---|---:|---|
| MUTAMBA RODGERS | (unassigned) | Ssentumbwe Gideon  | 968,313 | 2026-01-18 | 2026-04-18 | 185 | none |
| Babirye betty | Eric Natamba | Nabukenya frank | 552,000 | 2026-05-15 | 2026-06-14 | 128 | open |
| SSEKATE HAMIDU | Martin Muhwezi | SSEKATE STEVEN | 425,000 | 2026-04-13 | 2026-05-13 | 160 | none |
| Kalyango Ivan | ONESMUS AKAMPURIRA | kibuuli John | 419,000 | 2026-09-15 | 2026-09-17 | 33 | open |
| Nalumu Lillian | Nabwire resty | kalyango muhamahdi | 419,000 | 2026-09-15 | 2026-09-16 | 34 | open |
| Kabuye Zaina | OACAR ARNOLD | Najuko Sharifah | 419,000 | 2026-07-29 | 2026-08-28 | 53 | open |
| Kalange Muhammad | Mukisa juli | Namata Immaculate | 276,000 | 2026-09-17 | 2026-10-17 | 3 | open |
| Namutebbi Christine Marry | Muyomba Peter | Namuddu Christine | 276,000 | 2026-07-23 | 2026-08-22 | 59 | open |
| Namuli Cathy | IAN MUHWEZI | Jumba Frank | 276,000 | 2026-05-15 | 2026-06-14 | 128 | open |
| Ziwa Fred | ONESMUS AKAMPURIRA | BETTY NASOLO | 276,000 | 2026-09-11 | 2026-10-11 | 9 | open |
| Tushemerirwe Immaculate | FRED MUWANGUZI | Nasukusa Manjjerine | 276,000 | 2026-09-15 | 2026-09-04 | 46 | open |
| Nalugo Ruth | OACAR ARNOLD | Namuyamba Ruth | 276,000 | 2026-06-30 | 2026-07-30 | 82 | open |
| Kabuye Damiyano | Ssewava Musa  | Nanozi Lydia | 246,000 | 2026-03-11 | 2026-04-10 | 193 | none |
| Walugembe George William | Akampurira Onesmus | Lutaaya Frank | 216,000 | 2026-04-10 | 2026-05-10 | 163 | none |
| Isiko Jidith | Munguhili Happy | Nakalyango sarah | 209,500 | 2026-09-15 | 2026-09-26 | 24 | open |
| Nabukenya Nuliati | Baganzi Ali | kalyanga Ibrahim | 209,500 | 2026-09-15 | 2026-09-17 | 33 | open |
| Namusosa Esther | FRED MUWANGUZI | Muwumba rose | 209,500 | 2026-09-15 | 2026-09-04 | 46 | open |
| SSEKATE HAMIDU | Martin Muhwezi | Angella Namuyomba | 206,000 | - | 2026-04-25 | 178 | none |
| Kato Bashir | Kiggundu Akram | Kayondo Sharif | 205,028 | 2026-02-24 | 2026-04-25 | 178 | none |
| Ndikola Hamuza | Kiggundu Akram | Kayondo Sharif | 166,208 | 2026-02-24 | 2026-04-25 | 178 | none |
| Agalejjo Jonathan Francis | Benjamin Muhanguzi | Christopher | 117,300 | 2026-03-12 | 2026-04-11 | 192 | none |

## Plan ids

| Tenant | Plan id | Landlord paid |
|---|---|---|
| Mbonimpa Emmanuel | `b20e7b84-a71b-47d0-acb0-54f5db74baee` | YES |
| Evans Kalaba Mugerwa | `1d406d19-79a6-42eb-8782-581b3b247581` | YES |
| MUTAMBA RODGERS | `6be06a42-edfa-43f6-b642-f4a5ad5aa578` | NO RECORD |
| Wamuti Edrine | `6ede4500-a55a-473a-ae5a-8d223e5ac569` | YES |
| Namutebi Phiona | `3c463e9f-77cb-40fa-904b-7b4fdad0f092` | YES |
| Nakanwagi Noelina Mary | `7608e49d-4490-4419-90bf-5d2289d18dd8` | YES |
| Naigaga Zaina | `073b03ac-5565-4fa8-80f5-c53613825c6b` | YES |
| Babirye betty | `3735a62d-13f9-41ae-9506-72ad3c477cc9` | allocated, NOT paid |
| Alex Kawadwa | `1b936a29-ff57-4129-ac2d-2c1215dd279d` | YES |
| SSEKATE HAMIDU | `ac2a40b5-c1fa-4a40-9c3e-914a314e4ddd` | NO RECORD |
| Kalyango Ivan | `022bb100-eabe-427a-93a5-690dbc47686d` | allocated, NOT paid |
| Kabuye Sulaiman | `2fe85f01-112f-4316-a774-635b88a605da` | YES |
| Lubega John | `74205c05-523c-43dc-b799-e144bfcd942f` | YES |
| nakugude annet | `6b851e79-d556-469b-a5f2-99168fb94c45` | YES |
| Namaganda Eseza | `cb357f87-66db-4121-aab6-7cf324d7bb29` | YES |
| Nalumu Lillian | `998294b9-09c6-460e-81f2-b256cc6138c9` | allocated, NOT paid |
| Kabuye Zaina | `40bc86c4-86c1-41d1-abb3-d9de8ad66a28` | allocated, NOT paid |
| Akansasira Judith | `3c747bf4-a15b-4b80-9350-811cb3983b92` | YES |
| Kalange Muhammad | `5d2fc34c-c02f-453d-b754-f8c43bf904c0` | allocated, NOT paid |
| Namutebbi Christine Marry | `4550faba-08a8-44b9-a647-21c61835fe2e` | allocated, NOT paid |
| Namuli Cathy | `baf221e3-ff66-4a70-a11c-3716bb03b974` | allocated, NOT paid |
| Ziwa Fred | `04c5ec5f-eb1e-4be9-85f3-b643f1c2252b` | allocated, NOT paid |
| Tushemerirwe Immaculate | `158df32a-5ae9-4363-b941-e0aaa3b5c11f` | allocated, NOT paid |
| Kilama Emmanuel | `a0125faa-8f20-47e1-bc9b-a0e9484ab10c` | YES |
| Nalugo Ruth | `b38d724f-6695-42f3-abd8-debb1d075c03` | allocated, NOT paid |
| KIZITO ABEL | `cad4635a-c7f6-4efe-b8ef-243ab00b4976` | YES |
| Kabuye Damiyano | `08907aab-dad3-4bb5-a277-a228dfcbd300` | NO RECORD |
| Walugembe George William | `f82e8d01-809b-4a5e-8dca-11408bbc94f5` | NO RECORD |
| Test Tenant 164 | `c62755d0-ed8e-4fbb-a876-185301519d14` | YES |
| Isiko Jidith | `0fbdfa9e-a6f2-4656-9fd8-b9eb3752958e` | allocated, NOT paid |
| Nabukenya Nuliati | `d9fe7f94-e146-46fb-b468-7f95ce8719a4` | allocated, NOT paid |
| Namusosa Esther | `40a393bf-84db-49fa-acd8-652cbf1223cd` | allocated, NOT paid |
| SSEKATE HAMIDU | `75a1c591-3f32-48bd-b344-7339e0f7e8fc` | NO RECORD |
| Kato Bashir | `532be737-2ed9-4a6f-8888-39e4dae41439` | NO RECORD |
| Ndikola Hamuza | `b87f5dad-cb27-433f-89bc-46f5be3690f2` | NO RECORD |
| Mr Brian Byamugisha | `80e08a38-5197-43db-94dd-b45b9b7314d8` | YES |
| Ssebaduka Betty | `bb6c2004-105c-4059-ae86-3495f198adff` | YES |
| Agalejjo Jonathan Francis | `2849983b-8576-49bb-b4e4-7c83d90815cc` | NO RECORD |
| Yaseen Kc💎 | `b0b1f24e-f099-4bd3-84bc-666afa6980d7` | YES |
| Nanyonga Mariam | `ccace68a-b552-4fcd-beed-76a02f035aea` | YES |
