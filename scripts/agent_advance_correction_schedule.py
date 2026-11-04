"""Agent advance receivables (A10 / A11) correction schedule, from the read-only production extracts of 2026-11-04.
Rules (proposed; nothing posted):
 Part A - closed advances (completed / cancelled) must carry A10 = A11 = 0.
   A1 A11 left from the 22 Sep opening            -> DR E3 / CR A11 (restatement reversal)
   A2 A11 left from a fee charged at issue         -> DR agent_advance_fee_revenue / CR A11 (fee reversed: advance cancelled)
   A3 A10 above the principal still unpaid          -> DR E3 / CR A10 (22 Sep opening double-counted the disbursement)
   A4 A10 principal unpaid on a cancelled advance   -> DR X4 platform_loss_writeoff / CR A10  (or transfer - CFO decision)
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
            add(r, 'A', 'A4', 'X4 platform_loss_writeoff (or transfer: CFO decision)', 'A10 agent_advance_writeoff', loss,
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
    for side, sign in (('debit', 1), ('credit', -1)):
        acct = x[side].split()[0]
        eff[acct] += sign * x['amount']
print({k: round(v, 2) for k, v in eff.items()})
print('rows', len(rows))
