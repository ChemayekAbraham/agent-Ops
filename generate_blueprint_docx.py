import os
import docx
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml import parse_xml, OxmlElement
from docx.oxml.ns import nsdecls, qn

def set_cell_background(cell, fill_hex):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{fill_hex}"/>')
    tcPr.append(shd)

def set_cell_margins(cell, top=100, bottom=100, left=150, right=150):
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = parse_xml(f'<w:tcMar {nsdecls("w")}><w:top w:w="{top}" w:type="dxa"/><w:bottom w:w="{bottom}" w:type="dxa"/><w:left w:w="{left}" w:type="dxa"/><w:right w:w="{right}" w:type="dxa"/></w:tcMar>')
    tcPr.append(tcMar)

def create_blueprint_document():
    doc = docx.Document()

    # Page Margins
    for section in doc.sections:
        section.top_margin = Inches(0.9)
        section.bottom_margin = Inches(0.9)
        section.left_margin = Inches(0.9)
        section.right_margin = Inches(0.9)

    # Styles
    normal_style = doc.styles['Normal']
    normal_style.font.name = 'Calibri'
    normal_style.font.size = Pt(10.5)
    normal_style.font.color.rgb = RGBColor(0x1E, 0x29, 0x3B)

    # Brand Colors
    NAVY = RGBColor(0x1E, 0x29, 0x5D)
    TEAL = RGBColor(0x0F, 0x76, 0x6E)
    BLUE = RGBColor(0x02, 0x84, 0xC7)
    AMBER = RGBColor(0xD9, 0x77, 0x06)
    EMERALD = RGBColor(0x05, 0x96, 0x69)
    GRAY = RGBColor(0x64, 0x74, 0x8B)

    # ==================== HEADER ====================
    p_meta = doc.add_paragraph()
    p_meta.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    r_meta = p_meta.add_run("WELILE TECHNOLOGIES LIMITED · OPERATIONAL BLUEPRINT\nDOCUMENT ID: WEL-BP-SPIRO-BIKE-2026-V1 · CONFIDENTIAL")
    r_meta.font.size = Pt(8.5)
    r_meta.font.bold = True
    r_meta.font.color.rgb = GRAY

    # Title
    p_title = doc.add_paragraph()
    p_title.paragraph_format.space_before = Pt(12)
    p_title.paragraph_format.space_after = Pt(4)
    r_title = p_title.add_run("Welile Spiro Electric Motorbike Program Blueprint")
    r_title.font.size = Pt(22)
    r_title.font.bold = True
    r_title.font.color.rgb = NAVY

    # Subtitle
    p_sub = doc.add_paragraph()
    p_sub.paragraph_format.space_after = Pt(14)
    r_sub = p_sub.add_run("Authoritative Operational, Technical & Financial Architecture: Spiro Electric Motorbike Leases, 28% Reducing Balance, pg_cron Sweeps, and Governance Q&A")
    r_sub.font.size = Pt(12)
    r_sub.font.color.rgb = TEAL

    # Executive Overview Callout
    box = doc.add_table(rows=1, cols=1)
    box.alignment = WD_TABLE_ALIGNMENT.CENTER
    box.columns[0].width = Inches(6.7)
    c = box.cell(0, 0)
    set_cell_background(c, "F1F5F9")
    set_cell_margins(c, 140, 140, 180, 180)
    p_box = c.paragraphs[0]
    r_bh = p_box.add_run("EXECUTIVE SUMMARY & PROGRAM SCOPE:\n")
    r_bh.font.bold = True
    r_bh.font.size = Pt(10)
    r_bh.font.color.rgb = NAVY
    r_bt = p_box.add_run(
        "This Blueprint establishes the authoritative operational, mathematical, and database architecture for the Spiro Electric Motorbike Lease Program at Welile Technologies Limited. It details how commercial mobility assets (Spiro Commando and ChapChap models) are originated, underwritten, disbursed, recovered via daily wallet sweeps, and legally discharged. Special focus is dedicated to the 28% monthly reducing-balance lease engine, automated daily wallet sweeps via pg_cron, double-entry general ledger posting rules, and full resolution of operational governance questions."
    )
    r_bt.font.size = Pt(9.5)
    r_bt.font.color.rgb = RGBColor(0x33, 0x41, 0x55)

    doc.add_paragraph() # Spacer

    # ==================== SECTION 1: SPIRO BIKE STRUCTURE ====================
    h1 = doc.add_heading(level=1)
    r1 = h1.add_run("1. Spiro Electric Motorbike Models & Commercial Lease Structure")
    r1.font.color.rgb = NAVY
    r1.font.bold = True

    doc.add_paragraph(
        "Welile provides active rent collection agents with asset-financed electric motorcycles designed to increase field route velocity, tenant onboarding, and daily collections:"
    )

    t_prod = doc.add_table(rows=3, cols=4)
    t_prod.alignment = WD_TABLE_ALIGNMENT.CENTER
    t_prod.columns[0].width = Inches(1.5)
    t_prod.columns[1].width = Inches(1.8)
    t_prod.columns[2].width = Inches(1.7)
    t_prod.columns[3].width = Inches(1.7)

    headers_prod = ["Bike Model", "Commercial Purpose", "Valuation & Terms", "Repayment Mechanism"]
    for i, h in enumerate(headers_prod):
        cell = t_prod.cell(0, i)
        set_cell_background(cell, "1E295D")
        set_cell_margins(cell, 100, 100, 100, 100)
        p = cell.paragraphs[0]
        r = p.add_run(h)
        r.font.bold = True
        r.font.size = Pt(9)
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

    prods = [
        ("Spiro Commando", "Heavy-duty electric motorcycle for rugged collection routes & high-mileage zones.", "Valuation: UGX 4.8M – 5.52M.\nRate: 28% monthly reducing balance.\nTerms: 1–24 months.\nDeposit: UGX 0.", "Automated daily sweep from withdrawable commissions (pg_cron)."),
        ("Spiro ChapChap", "Lightweight, agile commuter electric motorcycle for dense urban areas.", "Valuation: UGX 4.2M – 4.6M.\nRate: 28% monthly reducing balance.\nTerms: 1–24 months.\nDeposit: UGX 0.", "Automated daily sweep from withdrawable commissions (pg_cron)."),
    ]

    for row_idx, data in enumerate(prods, start=1):
        bg = "FFFFFF" if row_idx % 2 != 0 else "F8FAFC"
        for col_idx, text in enumerate(data):
            cell = t_prod.cell(row_idx, col_idx)
            set_cell_background(cell, bg)
            set_cell_margins(cell, 90, 90, 90, 90)
            p = cell.paragraphs[0]
            r = p.add_run(text)
            r.font.size = Pt(8.5)
            if col_idx == 0:
                r.font.bold = True
                r.font.color.rgb = NAVY

    doc.add_paragraph() # Spacer

    # ==================== SECTION 2: END-TO-END FLOWCHART ====================
    h2 = doc.add_heading(level=1)
    r2 = h2.add_run("2. End-to-End Business Model Flow & Blueprint")
    r2.font.color.rgb = NAVY
    r2.font.bold = True

    doc.add_paragraph(
        "The lifecycle of an asset finance order moves through five strict operational checkpoints, enforcing segregation of duties and automated risk controls:"
    )

    flow_box = doc.add_table(rows=1, cols=1)
    flow_box.alignment = WD_TABLE_ALIGNMENT.CENTER
    flow_box.columns[0].width = Inches(6.7)
    fc = flow_box.cell(0, 0)
    set_cell_background(fc, "F8FAFC")
    set_cell_margins(fc, 120, 120, 140, 140)
    fp = fc.paragraphs[0]
    fr = fp.add_run(
"""[STAGE 1: AGENT APPLICATION]
   Agent selects Bike Model & Term (1-24 mo) in Merchandise Store
   Validation: Must have ZERO running advances; Max 1 in-flight order.
   Accepts Terms & Conditions (Logbook custody, daily wallet sweep).
               │
               ▼
[STAGE 2: AGENT OPS AUDIT]
   Agent Ops verifies KYC (NIN, Phone), field collection velocity, and sub-agents.
   Checks running advance status. Records physical asset serials.
   Action: Approves (status = 'ops_approved') with Approver ID recorded.
               │
               ▼
[STAGE 3: COO COMMERCIAL APPROVAL]
   COO reviews commercial valuation, term viability, and supplier cost.
   Locks commercial pricing and repayment term.
   Action: Approves (status = 'coo_approved') with Approver ID recorded.
               │
               ▼
[STAGE 4: CFO DISBURSEMENT & ASSET ACTIVATION]
   CFO executes treasury disbursement to supplier; commits company float.
   Ledger posted: DEBIT Account A16 (Asset Receivable) / CREDIT L1 (Wallet).
   Physical bike delivered; Logbook retained in Welile Legal Custody Vault.
   Status becomes: 'approved' (Active Repayment).
               │
               ▼
[STAGE 5: AUTOMATED DAILY RECOVERY SWEEPS]
   pg_cron runs recover_merchandise_from_wallets() 4× daily (08:00, 14:00, 20:00, 02:00 EAT).
   Cap: At most 1 deduction per calendar day = min(Balance, Withdrawable Wallet, Daily Cap).
   Ledger split: Principal -> Platform Operational Float | Fee -> Access Fee Pool.
               │
               ▼
[STAGE 6: FULL SETTLEMENT & TITLE DISCHARGE]
   Outstanding Balance reaches exactly UGX 0.
   System auto-generates Certificate of Full Settlement PDF.
   Legal Ops discharges logbook; initiates official URA title transfer to agent.
   Agent unlocked for subsequent asset financing."""
    )
    fr.font.name = 'Consolas'
    fr.font.size = Pt(8)
    fr.font.color.rgb = NAVY

    doc.add_paragraph() # Spacer

    # ==================== SECTION 3: DATABASE ARCHITECTURE ====================
    h3 = doc.add_heading(level=1)
    r3 = h3.add_run("3. System Internals: Database Tables, Triggers & Cron Jobs")
    r3.font.color.rgb = NAVY
    r3.font.bold = True

    doc.add_paragraph(
        "The Welile platform maintains complete technical separation between cash advances, merchandise sales, and motorbike leases through dedicated relational schemas:"
    )

    doc.add_paragraph("Core Database Tables:", style='List Bullet')
    doc.add_paragraph("• public.agent_bike_leases: Dedicated asset table storing physical metadata (chassis_number, plate_number, battery_serial, gps_tracker_id, logbook_status, valuation_amount, amount_outstanding, approval audit timestamps, and approver names).", style='List Bullet 2')
    doc.add_paragraph("• public.agent_bike_lease_schedules: Pre-calculated month-by-month reducing-balance schedule rows at 28%, storing opening_principal, principal_due, fee_due, total_due, and daily_rate.", style='List Bullet 2')
    doc.add_paragraph("• public.merchandise_recovery_plans: Master execution table for the automated sweep cron. Flags bike leases with is_bike_lease = true, pricing_basis = 'spiro_28pct_v2', and daily_rate = 0.", style='List Bullet 2')
    doc.add_paragraph("• public.merchandise_recovery_deductions: Immutable per-sweep audit log recording transaction_ref, plan_id, amount, withdrawable_before, outstanding_after, and timestamp.", style='List Bullet 2')
    doc.add_paragraph("• public.agent_advances: Dedicated table for cash/shopping working capital loans, completely separate from merchandise.", style='List Bullet 2')
    doc.add_paragraph("• public.general_ledger: Universal double-entry accounting ledger recording atomic wallet debits and platform float credits.", style='List Bullet 2')

    doc.add_paragraph()

    doc.add_paragraph("Key Triggers & Stored Functions (RPCs):", style='List Bullet')
    doc.add_paragraph("• public.agent_order_spiro_bike_lease: Validates eligibility, enforces the single in-flight application lock, creates the order in agent_bike_leases, and links the initial merchandise sale.", style='List Bullet 2')
    doc.add_paragraph("• public.cfo_disburse_bike_lease: Executive function executed by the CFO. Activates the live lease, locks valuation, generates the active recovery plan in merchandise_recovery_plans, and posts initial ledger legs.", style='List Bullet 2')
    doc.add_paragraph("• public.recover_merchandise_from_wallets(): The automated recovery engine called by pg_cron. Performs balance checks, applies the daily cap, executes double-entry ledger entries, and stamps last_bike_recovery_on.", style='List Bullet 2')
    doc.add_paragraph("• public._spiro_lease_month(p_base, p_term, p_month): Returns the exact amortisation slice, 28% fee, total due, and daily deduction for any given month in the lease term.", style='List Bullet 2')

    doc.add_paragraph()

    # Cron Job Architecture Box
    cron_table = doc.add_table(rows=2, cols=3)
    cron_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    cron_table.columns[0].width = Inches(2.2)
    cron_table.columns[1].width = Inches(2.2)
    cron_table.columns[2].width = Inches(2.3)

    c_headers = ["Cron Name", "Schedule (UTC & EAT)", "Target RPC Function"]
    for i, ch in enumerate(c_headers):
        cell = cron_table.cell(0, i)
        set_cell_background(cell, "0F766E")
        set_cell_margins(cell, 80, 80, 80, 80)
        p = cell.paragraphs[0]
        r = p.add_run(ch)
        r.font.bold = True
        r.font.size = Pt(8.5)
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

    c_vals = [
        "recover-merchandise-from-wallets",
        "0 5,11,17,23 * * *\n(08:00, 14:00, 20:00, 02:00 EAT)",
        "SELECT public.recover_merchandise_from_wallets();"
    ]
    for i, cv in enumerate(c_vals):
        cell = cron_table.cell(1, i)
        set_cell_background(cell, "F8FAFC")
        set_cell_margins(cell, 80, 80, 80, 80)
        p = cell.paragraphs[0]
        r = p.add_run(cv)
        r.font.size = Pt(8.5)
        if i == 0:
            r.font.bold = True

    doc.add_paragraph() # Spacer

    # ==================== SECTION 4: MATHEMATICAL WORKED EXAMPLES ====================
    h4 = doc.add_heading(level=1)
    r4 = h4.add_run("4. Mathematical Formulas & Worked Examples")
    r4.font.color.rgb = NAVY
    r4.font.bold = True

    doc.add_paragraph(
        "The reducing-balance formula charges 28% exclusively on the unamortised principal at the start of each month. Below are two real-world case studies:"
    )

    # Example 1: Ronald Musana
    doc.add_paragraph("Case Study 1: Ronald Musana (UGX 4,800,000 Valuation, 6-Month Lease)", style='List Bullet')
    doc.add_paragraph("• Monthly Principal Slice (P) = UGX 4,800,000 ÷ 6 = UGX 800,000 / month", style='List Bullet 2')
    doc.add_paragraph("• Total Access Fee = Base × [28% × (6 + 1) ÷ 2] = 4,800,000 × 0.98 = UGX 4,704,000 (98% total markup)", style='List Bullet 2')
    doc.add_paragraph("• Total Repayable = UGX 4,800,000 + UGX 4,704,000 = UGX 9,504,000", style='List Bullet 2')

    t_ex1 = doc.add_table(rows=8, cols=6)
    t_ex1.alignment = WD_TABLE_ALIGNMENT.CENTER
    t_widths1 = [Inches(0.8), Inches(1.2), Inches(1.1), Inches(1.2), Inches(1.2), Inches(1.2)]

    h_ex1 = ["Month", "Opening Principal", "Principal Due", "28% Fee Due", "Month Total Due", "Daily (30d)"]
    for i, h in enumerate(h_ex1):
        cell = t_ex1.cell(0, i)
        cell.width = t_widths1[i]
        set_cell_background(cell, "1E295D")
        set_cell_margins(cell, 80, 80, 70, 70)
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT if i > 0 else WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(h)
        r.font.bold = True
        r.font.size = Pt(8)
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

    ex1_rows = [
        ("Month 1", "4,800,000", "800,000", "1,344,000", "2,144,000", "71,467/d"),
        ("Month 2", "4,000,000", "800,000", "1,120,000", "1,920,000", "64,000/d"),
        ("Month 3", "3,200,000", "800,000", "896,000", "1,696,000", "56,534/d"),
        ("Month 4", "2,400,000", "800,000", "672,000", "1,472,000", "49,067/d"),
        ("Month 5", "1,600,000", "800,000", "448,000", "1,248,000", "41,600/d"),
        ("Month 6", "800,000", "800,000", "224,000", "1,024,000", "34,134/d"),
        ("TOTALS", "—", "4,800,000", "4,704,000", "9,504,000", "Avg 52,800/d"),
    ]

    for row_idx, rdata in enumerate(ex1_rows, start=1):
        bg = "E2E8F0" if row_idx == 7 else ("FFFFFF" if row_idx % 2 != 0 else "F8FAFC")
        for col_idx, val in enumerate(rdata):
            cell = t_ex1.cell(row_idx, col_idx)
            cell.width = t_widths1[col_idx]
            set_cell_background(cell, bg)
            set_cell_margins(cell, 60, 60, 70, 70)
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.RIGHT if col_idx > 0 else WD_ALIGN_PARAGRAPH.CENTER
            r = p.add_run(val)
            r.font.size = Pt(8)
            if row_idx == 7 or col_idx == 4:
                r.font.bold = True

    doc.add_paragraph()

    # Example 2: Alpha Ssema
    doc.add_paragraph("Case Study 2: Alpha Ssema (UGX 500,000 Valuation, 12-Month Lease)", style='List Bullet')
    doc.add_paragraph("• Monthly Principal Slice (P) = UGX 500,000 ÷ 12 = UGX 41,667 / month", style='List Bullet 2')
    doc.add_paragraph("• Total Access Fee = 500,000 × [28% × (12 + 1) ÷ 2] = 500,000 × 1.82 = UGX 910,000 (182% total markup)", style='List Bullet 2')
    doc.add_paragraph("• Total Repayable = UGX 500,000 + UGX 910,000 = UGX 1,410,000 (Average UGX 117,500/month; ~UGX 3,864/day)", style='List Bullet 2')

    doc.add_paragraph() # Spacer

    # ==================== SECTION 5: HIGHLIGHTED QUESTIONS DOWN THE DOCUMENT ====================
    h5 = doc.add_heading(level=1)
    r5 = h5.add_run("5. Highlighted Operational & Governance Questions (Detailed Clarifications)")
    r5.font.color.rgb = NAVY
    r5.font.bold = True

    qa_list = [
        (
            "1. Who is an active agent?",
            "An Active Agent is defined by four strict operational criteria:\n"
            "1. Verified Field Activity: Actively assigned to collection zones with verified daily or weekly rent collection transactions. Active collections generate commission inflows that land in the agent's withdrawable wallet.\n"
            "2. Profile in Good Standing: Verified National Identification Number (NIN), phone number, facial KYC, and zero active fraud flags. Not suspended or marked dormant by Agent Ops.\n"
            "3. Active Portfolio (Rolling 30 Days): Manages at least 1 active tenant on a Rent Plan and has processed verifiable rent collections within the last 30 calendar days.\n"
            "4. Zero Open Defaults: No unserviced arrears, defaulted advances, or unaccounted rent collections.\n\n"
            "Why activity matters: Welile provides the electric motorbike with UGX 0 upfront deposit. The lease self-liquidates entirely through commission earnings. If an agent stops collecting rent, their wallet has zero inflows and the asset cannot be serviced."
        ),
        (
            "2. Why would or under what circumstance would an agent post another submission on the same account?",
            "The platform enforces a strict lock: Maximum 1 In-Flight Bike Application per Agent.\n"
            "An agent may only submit another application under four legitimate circumstances:\n"
            "1. Previous Lease Fully Completed (Settled): The agent has cleared 100% of their prior bike balance (outstanding_balance == 0, status = 'completed'). Upon issuance of the Certificate of Full Settlement, the agent is unlocked to apply for a second bike or upgrade to expand their sub-agency fleet.\n"
            "2. Previous Application Formally Rejected: A prior application was rejected during Ops Verification, COO review, or CFO review (with reason logged), which unblocks the agent so they can submit with corrected terms (e.g. extending from 6 to 12 months, or selecting a lower-valuation model).\n"
            "3. Application Cancelled by Agent / Ops: The submission was cancelled before disbursement.\n"
            "4. Zero Running Advances Policy: Applicants must have no active or outstanding advance on their account. If an agent has an active running advance, they must first finish and clear that advance before they can qualify and submit an application for a Spiro bike lease.\n\n"
            "Submitting while an existing lease is actively repaying is strictly blocked to prevent double-debt loading and recovery failure."
        ),
        (
            "3. So you also use the same concept here — a 28% is charged monthly and recurring 15%?",
            "NO. The 'recurring 15%' concept is obsolete and has been completely deleted.\n\n"
            "• The 15% was an old prototype fallback rule used for generic store merchandise in early 2026: 'sweep 15% of any wallet credit until paid off'. It had no fixed term, no interest model, and no predictable maturity date.\n"
            "• Under Migration 0415, the 15% rate and the BIKE_RECOVERY_RATE = 0.15 constant were completely DELETED from the codebase and database.\n"
            "• The Spiro motorbike lease operates strictly on a genuine 28% monthly reducing-balance schedule. There is no recurring 15% rate applied anywhere in the bike flow."
        ),
        (
            "4. 'A daily sweep of the agent's available wallet balance, capped at the day's scheduled instalment. Nothing is swept on a day when the wallet is empty' — What wallet bucket is debited from, and what if the user wallet is less than target or empty?",
            "• Wallet Bucket Debited: The recovery sweep strictly debits the withdrawable_balance bucket in the agent's wallet (earned commissions). Company float_balance (landlord funds) and advance_balance are NEVER touched.\n\n"
            "• When Wallet is Below Daily Cap: The system sweeps whatever withdrawable balance is available: min(outstanding, available, daily_cap). If the target is UGX 71,467 and the wallet holds UGX 20,000, exactly UGX 20,000 is swept, reducing the balance and leaving the wallet at UGX 0. The remaining unpaid portion rolls over into unpaid principal without penalty.\n\n"
            "• When Wallet is Empty (UGX 0): The sweep takes UGX 0. The day is skipped cleanly. Zero penalty fees are added, no interest compounds, and no negative wallet overdraft is ever created. If 0 deductions occur for 7 consecutive days, the system triggers a Dormancy Alert for Agent Ops."
        ),
        (
            "5. Why charge 28% yet they pay 15% monthly?",
            "This question stems from conflating the old prototype collection percentage with the true lease interest rate:\n\n"
            "• The 15% was never a monthly interest charge; it was an arbitrary wallet sweep proportion ('take 15% of daily wallet earnings') used in generic store tests.\n"
            "• 28% is the true commercial facility fee rate applied to the unamortised opening principal each month.\n"
            "• Because 15% variable sweeps made it impossible to predict repayment completion, Welile removed the 15% rule and adopted the amortising reducing-balance schedule, giving agents a predictable daily installment that drops every month.\n"
            "• Furthermore, any daily commissions earned by the agent above their daily cap remain 100% withdrawable immediately for their personal use."
        ),
        (
            "6. Why must the 'manager' role be removed from the verification chain allowList?",
            "To enforce strict Four-Eyes Financial Governance and comply with audit requirements:\n\n"
            "• A generic 'manager' role is overly broad and allows operational personnel to approve capital assets without fiduciary oversight.\n"
            "• In Welile, an electric motorbike lease commits significant company capital (UGX 4.5M - 5.5M+ per unit).\n"
            "• The authorized approval chain is strictly locked to four roles:\n"
            "   1. Stage 1: Agent (Self-service order submission)\n"
            "   2. Stage 2: Agent Ops ONLY (Field identity, route, and collection audit)\n"
            "   3. Stage 3: COO ONLY (Commercial terms, valuation, and pricing approval)\n"
            "   4. Stage 4: CFO ONLY (Disbursement, treasury float commitment, and ledger activation)\n\n"
            "Removing 'manager' prevents unauthorized approval bypasses and ensures executive accountability."
        ),
        (
            "7. Strategic Assessment & Recommendations on Section 10 (Known Gaps & Open Decisions)",
            "Detailed operational review of the 8 technical and business items in Section 10:\n\n"
            "1. Day-Count Standardization (10.1): The reducing-balance schedule is canonical. Standardizing bike leases to a flat 30-day month (dividing monthly due by 30) harmonizes bike leases with Agent Advances and Rent Plans.\n"
            "2. Arrears & Dormancy Policy (10.2): Implemented two-sided visibility: Agent Ops receives 7-day dormancy alerts, while the agent receives a friendly dashboard banner encouraging collections. If inactive for 14 days, float issuance is paused pending a physical field audit.\n"
            "3. Logbook Title Custody (10.3): Physical logbook custody remains with Welile throughout the lease. Automatic certificate generation upon UGX 0 balance clears the legal hold for URA transfer.\n"
            "4. Table Separation (10.4 & 10.5): Completely decoupled bike leases into agent_bike_leases and agent_bike_lease_schedules, eliminating legacy merchandise ambiguities.\n"
            "5. Approver Audit Tracking (10.6): System now logs the user ID and full name of each approver at every stage (ops_approved_by, coo_approved_by, cfo_approved_by).\n"
            "6. Clickable Drilldowns (10.7): Ops officers can drill into applicant sub-agents, active tenants, and 30-day collections directly from the approval dialog.\n"
            "7. Valuation-Based Schedule (10.8): The repayment breakdown calculates the 28% fee directly on the true valuation amount, reading supplier cost from merchandise_catalog.unit_cost for clean profit accounting."
        ),
        (
            "8. How does the system know this is a bike lease since advance logic is already running?",
            "The system enforces complete technical and architectural isolation between Spiro bike leases and working capital advances:\n\n"
            "1. Dedicated Database Tables: Bike leases reside exclusively in agent_bike_leases (with monthly schedules in agent_bike_lease_schedules). Advances live exclusively in agent_advances. Query engines, UI stores, and cron sweep jobs operate on distinct tables.\n"
            "2. Distinct Double-Entry Ledger Accounts: Bike leases debit Account A11 (Agent Asset Finance Receivable), whereas advances debit Account A10 (Agent Advance Receivable). A11 requires supplier settlement to Spiro (Account L1), while A10 credits operational float.\n"
            "3. Separate RPC Workflows: Bike leases originate via agent_order_spiro_bike_lease and flow through verify_spiro_bike_lease, approve_spiro_bike_lease, and disburse_spiro_bike_lease. Advances follow standard float issuance RPCs.\n"
            "4. Physical Asset Tracking: Bike leases track chassis number, battery serial, GPS tracker ID, number plate, and logbook custody. Advances have no physical asset attributes.\n"
            "5. Zero Running Advance Rule: The system verifies that an agent has no active or unpaid advance before a bike lease can be approved or disbursed."
        )
    ]

    for q_title, q_body in qa_list:
        p_q = doc.add_paragraph()
        p_q.paragraph_format.space_before = Pt(8)
        p_q.paragraph_format.space_after = Pt(2)
        r_q = p_q.add_run(q_title)
        r_q.font.bold = True
        r_q.font.size = Pt(11)
        r_q.font.color.rgb = NAVY

        p_a = doc.add_paragraph()
        p_a.paragraph_format.space_after = Pt(6)
        r_a = p_a.add_run(q_body)
        r_a.font.size = Pt(9.5)
        r_a.font.color.rgb = RGBColor(0x33, 0x41, 0x55)

    doc.add_paragraph() # Spacer

    # ==================== SIGN-OFF BLOCK ====================
    st = doc.add_table(rows=2, cols=3)
    st.alignment = WD_TABLE_ALIGNMENT.CENTER
    st.columns[0].width = Inches(2.2)
    st.columns[1].width = Inches(2.2)
    st.columns[2].width = Inches(2.3)

    roles = ["Chief Operating Officer (COO)", "Chief Financial Officer (CFO)", "Director of Agent Operations"]
    for i, role in enumerate(roles):
        c1 = st.cell(0, i)
        set_cell_background(c1, "F1F5F9")
        set_cell_margins(c1, 100, 100, 100, 100)
        p1 = c1.paragraphs[0]
        r = p1.add_run(f"AUTHORISED BY:\n\n_________________________\n{role}")
        r.font.size = Pt(8.5)
        r.font.bold = True
        r.font.color.rgb = NAVY

        c2 = st.cell(1, i)
        set_cell_background(c2, "FFFFFF")
        set_cell_margins(c2, 60, 60, 100, 100)
        p2 = c2.paragraphs[0]
        r2 = p2.add_run("Welile Technologies Ltd\nOctober 2026 · Kampala, Uganda")
        r2.font.size = Pt(8)
        r2.font.color.rgb = GRAY

    # Save documents
    path1 = "/Users/djshirleybeats/Desktop/welilereceipts-com-98bba33b/Welile_Agent_Products_Services_Blueprint.docx"
    path2 = "/Users/djshirleybeats/Desktop/welilereceipts-com-98bba33b/docs/WELILE_AGENT_PRODUCTS_SERVICES_BLUEPRINT.docx"

    doc.save(path1)
    doc.save(path2)
    print(f"Blueprint created successfully:\n  - {path1}\n  - {path2}")

if __name__ == "__main__":
    create_blueprint_document()
