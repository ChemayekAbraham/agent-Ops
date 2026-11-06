"""Agent advance receivables (A10 / A11) correction schedule, from the read-only production extracts of 2026-11-04.
Rules (proposed; nothing posted):
 Part A - closed advances (completed / cancelled) must carry A10 = A11 = 0.
   A1 A11 left from the 22 Sep opening            -> DR E3 / CR A11 (restatement reversal)
   A2 A11 left from a fee charged at issue         -> DR agent_advance_fee_revenue / CR A11 (fee reversed: advance cancelled)
   A3 A10 above the principal still unpaid          -> DR E3 / CR A10 (22 Sep opening double-counted the disbursement)
   A4 A10 principal unpaid on a cancelled advance   -> DR X4 platform_loss_writeoff / CR A10 (only if forgiven: none are)
   A6 cancelled advance transferred elsewhere        -> DR E3 balance_correction / CR old A10 (A11): see TRANSFERS
   A7 old penalties capitalised into the new advance -> DR E3 / CR L8 unearned
   HOLD amount with no verified destination           -> no entry; CFO decision
   A5 A10 below zero (collected more than principal)-> DR A10 / CR agent_advance_fee_revenue (fees / penalties collected
                                                       were credited to A10)
 Part B - live advances (active / overdue): books (A10 + A11) should equal the record less registration fees (A20).
   B1 fee booked inside A10                          -> DR A11 / CR A10 (reclassification)
   B2 fee in the record, never booked               -> DR A11 / CR E3 (issued before the 22 Sep restatement) or
                                                       CR agent_advance_fee_revenue (issued after)
   B3 fee booked twice (A10 opening + A11)          -> DR E3 / CR A10
   B4 legacy overdue penalty still unpaid           -> DR A10 agent_advance_penalty_accrued / CR L8 unearned (as the
                                                       current engine) - CFO decision
   B5 anything left                                  -> listed for review, no entry
"""
import csv, json, re, sys

sp = sys.argv[1]
# Part A, cancelled advances transferred elsewhere (CFO 2026-11-04: not forgiven or written off). Each destination advance
# was created through the normal payout (DR A10 new / CR L1 wallet); the wallet credit was then returned to the platform
# by an "error correction" (DR L1 / CR E3 balance_correction). So the receivable sits on the new advance and the old one,
# with a matching credit in E3. Rule A6: DR E3 / CR old A10 (A11) for the amount transferred removes the old balance and
# the E3 credit together - the receivable stays once, on the destination advance. HOLD: no entry until the CFO decides.
TRANSFERS = {
  '9ef03c86-ec7a-4730-b32c-d86092feb81a': [  # Yaseen Kc -> 7612edc4 (25 Sep), wallet credit 5,100,000 reversed 11:16 (group fbfa846f)
    ('A6', 'E3 balance_correction (transfer)', 'A10 agent_advance_receivable_opening', 5100000.00,
     'transferred to advance 7612edc4 (5,100,000 principal, Returns 20%); wallet credit reversed by error correction fbfa846f'),
    ('HOLD', '(CFO decision)', '(CFO decision)', 1081667.06,
     'principal of 9ef03c86 not carried into 7612edc4 (old unpaid 6,181,667.06 vs 5,100,000 transferred): add to 7612edc4 or name the destination')],
  'b94abec1-37b7-4eb0-8af5-200373aa140b': [  # SHARIFU KALULE -> KALULE SHARIF c73ab9a3 (20 Oct), reversed 10:24 (group 9d43119f)
    ('A6', 'E3 balance_correction (transfer)', 'A10 agent_advance_receivable_opening', 1204223.04,
     'transferred to KALULE SHARIF advance c73ab9a3 (1,711,526.24 of the 3,211,526 principal); wallet credit reversed by 9d43119f')],
  'd2a3bbc1-9775-4ad3-a0a1-1accb83a4762': [  # Martin Lukwago -> 4909a09a (23 Oct), reversed 27 Oct (group 43e73a1b)
    ('A6', 'E3 balance_correction (transfer)', 'A10 agent_advance_receivable_opening', 462154.54,
     'principal transferred to advance 4909a09a (1,033,875 = principal 462,154.54 + fee 198,000 + penalties 353,702 + registration 20,000); reversed by 43e73a1b'),
    ('A7', 'E3 balance_correction (transfer)', 'L8 agent_advance_penalty_unearned', 353702.00,
     'old penalties capitalised into 4909a09a principal: unearned until collected (same treatment as rule B4)')],
  'd1ec4c4c-8e00-4d38-bcbf-3a010aecbcf2': [  # PRISCILLA LOLEM -> 3a4f5957 (20 Oct), wallet credit NOT reversed
    ('A6', 'E3 receivable_restatement_equity', 'A10 agent_advance_receivable_opening', 1030.00,
     'principal remainder; balance (397,613 of fees and penalties) moved to advance 3a4f5957'),
    ('HOLD', '(CFO decision)', '(CFO decision)', 397613.00,
     '3a4f5957 credited 397,613 to her wallet and it was NOT reversed (unlike the other transfers); 270,000 withdrawn 22-23 Oct. Record carries the debt once')],
  '288cbab8-0c82-4ac6-9632-11c44e724ef4': [  # KALULE SHARIF -> top-up on c73ab9a3 (28 Oct), cash credited again, not reversed
    ('HOLD', '(CFO decision)', '(CFO decision)', 1500000.00,
     'paid 1,500,000 on 27 Oct (withdrawn 28 Oct); "topped up" into c73ab9a3 on 28 Oct with a second 1,500,000 wallet credit, still in his wallet. Books carry 3,000,000, record 1,500,000')],
}
A11_TRANSFER = {
  'b94abec1-37b7-4eb0-8af5-200373aa140b': (507302.96, 'fee part of the 1,711,526.24 transferred to c73ab9a3'),
}
out_csv = sys.argv[2]
R = json.load(open(f'{sp}/adv/peradv.json.clean.json'))
LIVE = {i['id']: i for i in json.load(open(f'{sp}/adv/peradv.json.clean.json.live.json'))}
f = lambda v: float(v or 0)
RESTATE = '2026-09-22'
rows = []


def add(r, part, rule, dr, cr, amt, note=''):
    if abs(amt) >= 1:
        rows.append(dict(part=part, rule=rule, agent=r['who'], advance=r['id'], status=r['status'], issued=r['issued'],
                         debit=dr, credit=cr, amount=round(amt, 2), note=note))


for r in R:
    a10, a11 = f(r['a10']), f(r['a11'])
    if r['status'] in ('completed', 'cancelled'):
        if abs(a10) < 1 and abs(a11) < 1:
            continue
        # A11
        if a11 >= 1 and r['id'] in A11_TRANSFER:
            t_amt, t_note = A11_TRANSFER[r['id']]
            add(r, 'A', 'A6', 'E3 balance_correction (transfer)', 'A11 agent_access_fee_receivable_opening', t_amt, t_note)
            a11 -= t_amt
        if a11 >= 1:
            from_open = min(a11, max(0, f(r['open11'])))
            add(r, 'A', 'A1', 'E3 receivable_restatement_equity', 'A11 agent_access_fee_receivable_opening', from_open, '22 Sep opening fee on a closed advance')
            add(r, 'A', 'A2', 'R agent_advance_fee_revenue (reversal)', 'A11 agent_advance_access_fee_charged', a11 - from_open, 'fee charged at issue; advance cancelled')
        # A10
        repaid = -(f(r['rep_before']) + f(r['rep_after']))
        unpaid = max(0, f(r['principal']) - repaid)
        if a10 >= 1:
            loss = min(a10, unpaid) if r['status'] == 'cancelled' else 0
            add(r, 'A', 'A3', 'E3 receivable_restatement_equity', 'A10 agent_advance_receivable_opening', a10 - loss, 'A10 above the principal still unpaid (22 Sep opening double count)')
            if r['id'] in TRANSFERS:
                for (part_rule, dr, cr, amt, note) in TRANSFERS[r['id']]:
                    add(r, 'A', part_rule, dr, cr, amt, note)
            else:
                add(r, 'A', 'A4', 'X4 platform_loss_writeoff', 'A10 agent_advance_writeoff', loss,
                    f"cancelled '{(r['why'] or '').strip()}' mode {r['cm']}; principal unpaid {unpaid:,.0f}")
        elif a10 <= -1:
            add(r, 'A', 'A5', 'A10 agent_advance_repayment (reclass)', 'R agent_advance_fee_revenue', -a10, 'collected more than principal: fees / penalties credited to A10')
    elif r['status'] in ('active', 'overdue'):
        i = LIVE[r['id']]
        fee_gap, resid = i['fee_gap'], i['resid']
        if fee_gap < -0.5 or (i['a11'] > 0 and resid < -1 and f(r['open10']) >= f(r['principal']) + f(r['access_fee']) - 1):
            # fee booked twice: inside the A10 opening and in A11
            dup = min(-resid, f(r['access_fee'])) if resid < 0 else 0
            add(r, 'B', 'B3', 'E3 receivable_restatement_equity', 'A10 agent_advance_receivable_opening', dup, 'fee in the A10 opening and in A11')
            resid += dup
            fee_gap = 0
        recl = min(max(fee_gap, 0), max(-resid, 0))
        add(r, 'B', 'B1', 'A11 agent_access_fee_receivable_opening', 'A10 agent_advance_receivable_opening', recl, 'access fee booked in A10')
        missing = max(fee_gap, 0) - recl
        if str(r['issued']) < RESTATE:
            add(r, 'B', 'B2', 'A11 agent_access_fee_receivable_opening', 'E3 receivable_restatement_equity', missing, 'fee left out of the 22 Sep opening')
        else:
            add(r, 'B', 'B2', 'A11 agent_advance_access_fee_charged', 'R agent_advance_fee_revenue', missing, 'fee never charged at issue')
        resid_after = resid + recl
        pen = min(max(resid_after, 0), i['legacy_pen'])
        add(r, 'B', 'B4', 'A10 agent_advance_penalty_accrued', 'L8 agent_advance_penalty_unearned', pen, 'legacy overdue penalty unpaid (CFO decision)')
        rest = resid_after - pen
        add(r, 'B', 'B5', '(review)', '(review)', rest, 'not explained by fees, registration (A20) or penalties')

with open(out_csv, 'w', newline='', encoding='utf-8') as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)
from collections import defaultdict
agg = defaultdict(lambda: [0, 0.0])
for x in rows:
    agg[x['rule']][0] += 1; agg[x['rule']][1] += x['amount']
for k in sorted(agg):
    print(k, agg[k][0], f'{agg[k][1]:,.2f}')
# net effect on A10 / A11 per rule
eff = defaultdict(float)
for x in rows:
    if x['rule'] == 'HOLD':
        continue
    for side, sign in (('debit', 1), ('credit', -1)):
        acct = x[side].split()[0]
        eff[acct] += sign * x['amount']
print({k: round(v, 2) for k, v in eff.items()})
print('rows', len(rows))
