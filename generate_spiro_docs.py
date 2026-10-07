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

def create_document():
    doc = docx.Document()

    # Set page margins
    sections = doc.sections
    for section in sections:
        section.top_margin = Inches(1)
        section.bottom_margin = Inches(1)
        section.left_margin = Inches(1)
        section.right_margin = Inches(1)

    # Base styling
    normal_style = doc.styles['Normal']
    normal_style.font.name = 'Calibri'
    normal_style.font.size = Pt(11)
    normal_style.font.color.rgb = RGBColor(0x22, 0x22, 0x22)

    # Palette
    PRIMARY = RGBColor(0x1E, 0x29, 0x5D)    # Deep Welile Navy
    SECONDARY = RGBColor(0x02, 0x84, 0xC7)  # Accent Blue
    SUCCESS = RGBColor(0x05, 0x96, 0x69)    # Emerald Green
    MUTED = RGBColor(0x64, 0x74, 0x8B)      # Slate gray

    # ------------------ COVER / HEADER ------------------
    p_meta = doc.add_paragraph()
    p_meta.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run_meta = p_meta.add_run("WELILE TECHNOLOGIES LIMITED\nOPERATIONAL ARCHITECTURE SPECIFICATION\nDOC ID: WEL-SPIRO-PROC-2026-V3")
    run_meta.font.size = Pt(9)
    run_meta.font.bold = True
    run_meta.font.color.rgb = MUTED

    doc.add_paragraph() # Spacer

    title_p = doc.add_paragraph()
    title_run = title_p.add_run("Welile Spiro Electric Motorbike Lease Program")
    title_run.font.size = Pt(24)
    title_run.font.bold = True
    title_run.font.color.rgb = PRIMARY

    sub_p = doc.add_paragraph()
    sub_run = sub_p.add_run("Complete End-to-End Process Guide: Qualification, Underwriting, Reducing-Balance Repayment Engine, Daily Wallet Sweeps, and Full Settlement")
    sub_run.font.size = Pt(14)
    sub_run.font.color.rgb = SECONDARY

    doc.add_paragraph() # Spacer

    # Summary Callout Box (1-cell table)
    callout = doc.add_table(rows=1, cols=1)
    callout.alignment = WD_TABLE_ALIGNMENT.CENTER
    callout.autofit = False
    callout.columns[0].width = Inches(6.5)
    c_cell = callout.cell(0, 0)
    set_cell_background(c_cell, "F1F5F9")
    set_cell_margins(c_cell, 150, 150, 200, 200)
    cp = c_cell.paragraphs[0]
    cp.paragraph_format.space_before = Pt(4)
    cp.paragraph_format.space_after = Pt(4)
    c_run = cp.add_run("EXECUTIVE SUMMARY:\n")
    c_run.font.bold = True
    c_run.font.size = Pt(10)
    c_run.font.color.rgb = PRIMARY
    c_desc = cp.add_run(
        "The Welile Spiro Motorbike Lease Program enables verified active rent collection agents to acquire commercial electric motorbikes with UGX 0 upfront deposit. The asset is financed on a 28% monthly reducing-balance lease over flexible terms (1 to 24 months), self-liquidated exclusively via daily automated sweeps from commission earnings in the agent's withdrawable wallet, while legal logbook title is retained in Welile custody until full settlement."
    )
    c_desc.font.size = Pt(10)
    c_desc.font.color.rgb = RGBColor(0x33, 0x41, 0x55)

    doc.add_paragraph() # Spacer

    # ------------------ SECTION 1: PROGRAM ARCHITECTURE & LIFECYCLE ------------------
    h1 = doc.add_heading(level=1)
    r1 = h1.add_run("1. Program Architecture & 6-Stage Lifecycle")
    r1.font.color.rgb = PRIMARY
    r1.font.bold = True

    p = doc.add_paragraph(
        "The Welile Spiro program is engineered as a secure, closed-loop asset financing pipeline. The entire lifecycle comprises six distinct operational gates:"
    )

    lifecycle_table = doc.add_table(rows=7, cols=3)
    lifecycle_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    lifecycle_table.autofit = False
    widths = [Inches(1.0), Inches(2.2), Inches(3.3)]

    headers = ["Stage", "Gate / Process Name", "Operational Ownership & Control"]
    for i, h in enumerate(headers):
        cell = lifecycle_table.cell(0, i)
        cell.width = widths[i]
        set_cell_background(cell, "1E295D")
        set_cell_margins(cell, 120, 120, 120, 120)
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        run = p.add_run(h)
        run.font.bold = True
        run.font.size = Pt(9.5)
        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

    stages_data = [
        ("Stage 1", "Agent Qualification & Application", "Agent Self-Service via Merchandise Storefront. Enforces identity verification and the Zero Running Advance rule."),
        ("Stage 2", "Agent Ops Underwriting & Audit", "Agent Operations Directorate. Reviews collection velocity, active advance status, and validates debt service ratio."),
        ("Stage 3", "COO & CFO Approval & Funding", "Executive Leadership. COO approves asset issuance; CFO commits company funding float and releases bike from inventory."),
        ("Stage 4", "Asset Handover & Logbook Custody", "Field Operations. Bike handover with asset serial/plate. Physical registration logbook deposited in Welile Legal Custody Vault."),
        ("Stage 5", "Reducing-Balance Repayment Sweeps", "Automated Database Engine (pg_cron). Executes daily automated sweeps from withdrawable commission wallet at 28%/month reducing rate."),
        ("Stage 6", "Full Settlement & Legal Discharge", "Automated Settlement Engine & Legal Ops. Issues certified Certificate of Full Settlement and legally transfers logbook to agent."),
    ]

    for row_idx, data in enumerate(stages_data, start=1):
        bg = "FFFFFF" if row_idx % 2 != 0 else "F8FAFC"
        for col_idx, text in enumerate(data):
            cell = lifecycle_table.cell(row_idx, col_idx)
            cell.width = widths[col_idx]
            set_cell_background(cell, bg)
            set_cell_margins(cell, 100, 100, 120, 120)
            p = cell.paragraphs[0]
            r = p.add_run(text)
            r.font.size = Pt(9)
            if col_idx == 0:
                r.font.bold = True
                r.font.color.rgb = PRIMARY
            elif col_idx == 1:
                r.font.bold = True

    doc.add_paragraph() # Spacer

    # ------------------ SECTION 2: QUALIFICATION & ZERO RUNNING ADVANCE RULE ------------------
    h2 = doc.add_heading(level=1)
    r2 = h2.add_run("2. Qualification Prerequisites & The Zero Running Advance Policy")
    r2.font.color.rgb = PRIMARY
    r2.font.bold = True

    doc.add_paragraph(
        "To qualify for a Welile Spiro electric bike lease, the applicant must meet strict commercial eligibility criteria:"
    )

    doc.add_paragraph(
        "• Verified Agent Profile: Must possess an active agent account, verified National Identification Number (NIN), verified mobile money phone number, and pass facial/ID KYC checks.",
        style='List Bullet'
    )
    doc.add_paragraph(
        "• Active Rent Collection Performance: Must demonstrate sustained rent collection activity across assigned landlord properties. Inactive agents are disqualified because repayment relies strictly on commission earnings.",
        style='List Bullet'
    )
    doc.add_paragraph(
        "• Single In-Flight Lease Lock: The system enforces a hard platform rule: an agent can only have one active bike lease at any given time. A second bike submission is strictly locked until the existing lease is 100% completed or cancelled.",
        style='List Bullet'
    )
    doc.add_paragraph(
        "• Zero Running Advances Policy: Having an active running advance is strictly prohibited. If an agent has any running agent advance, shopping advance, or cash advance, they are not allowed to receive a bike lease and must first finish clearing their active advance.",
        style='List Bullet'
    )

    adv_box = doc.add_table(rows=1, cols=1)
    adv_box.alignment = WD_TABLE_ALIGNMENT.CENTER
    adv_box.columns[0].width = Inches(6.5)
    ac = adv_box.cell(0, 0)
    set_cell_background(ac, "FEF3C7")
    set_cell_margins(ac, 120, 120, 150, 150)
    ap = ac.paragraphs[0]
    ar = ap.add_run("REGULATORY POLICY STATEMENT — ZERO RUNNING ADVANCES:\n")
    ar.font.bold = True
    ar.font.size = Pt(10)
    ar.font.color.rgb = RGBColor(0x92, 0x40, 0x0E)
    ar2 = ap.add_run(
        "\"Having an active running advance is not allowed. If you have any active or outstanding advance, you must first finish clearing it before you can qualify for a bike lease. Both advances and bike leases recover directly from wallet earnings; clearing existing liabilities first guarantees sustainable debt servicing.\""
    )
    ar2.font.size = Pt(9.5)
    ar2.font.color.rgb = RGBColor(0x78, 0x35, 0x0F)

    doc.add_paragraph() # Spacer

    # ------------------ SECTION 3: MATHEMATICAL PRICING & REPAYMENT ENGINE ------------------
    h3 = doc.add_heading(level=1)
    r3 = h3.add_run("3. Mathematical Pricing Engine (28% Reducing Balance)")
    r3.font.color.rgb = PRIMARY
    r3.font.bold = True

    doc.add_paragraph(
        "The Spiro bike lease does not use a flat markup or fixed percentage fee. Instead, it runs on an authentic reducing-balance amortisation model with a monthly facility fee rate of 28% (0.28) applied exclusively to the principal balance outstanding at the start of that month."
    )

    doc.add_paragraph("The Core Mathematical Formulas:", style='List Bullet')
    doc.add_paragraph("1. Monthly Principal Amortisation Slice (P):\n   P = Base Valuation ÷ Lease Term in Months (n)", style='List Bullet 2')
    doc.add_paragraph("2. Monthly Opening Principal (Opening_m):\n   Opening_m = Base Valuation - [(m - 1) × P]", style='List Bullet 2')
    doc.add_paragraph("3. Monthly Access Fee (Fee_m):\n   Fee_m = Opening_m × 28%", style='List Bullet 2')
    doc.add_paragraph("4. Total Due in Month m (Due_m):\n   Due_m = P + Fee_m", style='List Bullet 2')
    doc.add_paragraph("5. Monthly Closing Principal (Closing_m):\n   Closing_m = Opening_m - P (Reaches exactly UGX 0 in final month)", style='List Bullet 2')
    doc.add_paragraph("6. Total Cumulative Access Fee over Term (Total Fee):\n   Total Fee = Base Valuation × [28% × (n + 1) ÷ 2]", style='List Bullet 2')

    doc.add_paragraph()

    # Alpha Ssema Concrete Schedule Table
    p_tbl_lbl = doc.add_paragraph()
    p_tbl_lbl_run = p_tbl_lbl.add_run("Table 3.1: Complete 12-Month Repayment Schedule (Example: UGX 500,000 Bike Valuation)")
    p_tbl_lbl_run.font.bold = True
    p_tbl_lbl_run.font.size = Pt(10.5)
    p_tbl_lbl_run.font.color.rgb = PRIMARY

    sched_table = doc.add_table(rows=14, cols=7)
    sched_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    sched_table.autofit = False
    s_widths = [Inches(0.6), Inches(1.1), Inches(1.0), Inches(1.0), Inches(1.1), Inches(0.8), Inches(1.0)]

    s_headers = ["Mo", "Opening (UGX)", "Principal (UGX)", "Fee 28% (UGX)", "Month Due (UGX)", "Daily", "Closing (UGX)"]
    for i, h in enumerate(s_headers):
        cell = sched_table.cell(0, i)
        cell.width = s_widths[i]
        set_cell_background(cell, "1E295D")
        set_cell_margins(cell, 100, 100, 80, 80)
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT if i > 0 else WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run(h)
        run.font.bold = True
        run.font.size = Pt(8.5)
        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

    # 12-Month data for 500,000
    base = 500000
    n = 12
    p_slice = base / n
    cur_bal = base
    tot_fee = 0
    tot_due = 0

    for m in range(1, 13):
        opening = cur_bal
        fee = opening * 0.28
        due = p_slice + fee
        closing = max(0, opening - p_slice)
        cur_bal = closing
        tot_fee += fee
        tot_due += due
        daily_30 = round(due / 30)

        row_idx = m
        bg = "FFFFFF" if m % 2 != 0 else "F8FAFC"
        row_vals = [
            f"M{m}",
            f"{int(round(opening)):,}",
            f"{int(round(p_slice)):,}",
            f"{int(round(fee)):,}",
            f"{int(round(due)):,}",
            f"{daily_30:,}/d",
            f"{int(round(closing)):,}"
        ]

        for col_idx, val in enumerate(row_vals):
            cell = sched_table.cell(row_idx, col_idx)
            cell.width = s_widths[col_idx]
            set_cell_background(cell, bg)
            set_cell_margins(cell, 70, 70, 70, 70)
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.RIGHT if col_idx > 0 else WD_ALIGN_PARAGRAPH.CENTER
            r = p.add_run(val)
            r.font.size = Pt(8.5)
            if col_idx == 4:
                r.font.bold = True
            elif col_idx == 6 and m == 12:
                r.font.bold = True
                r.font.color.rgb = SUCCESS

    # Totals Row
    t_cell = sched_table.cell(13, 0)
    set_cell_background(t_cell, "E2E8F0")
    t_cell.paragraphs[0].add_run("TOTAL").font.bold = True
    t_cell.paragraphs[0].runs[0].font.size = Pt(8.5)

    tot_vals = ["—", f"{base:,}", f"{int(round(tot_fee)):,}", f"{int(round(tot_due)):,}", "Avg 3,917", "0"]
    for c_i, t_val in enumerate(tot_vals, start=1):
        cell = sched_table.cell(13, c_i)
        set_cell_background(cell, "E2E8F0")
        set_cell_margins(cell, 80, 80, 70, 70)
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        r = p.add_run(t_val)
        r.font.bold = True
        r.font.size = Pt(8.5)
        if c_i == 2:
            r.font.color.rgb = PRIMARY
        elif c_i == 3:
            r.font.color.rgb = SECONDARY

    doc.add_paragraph() # Spacer

    # ------------------ SECTION 4: DAY COUNT MODELS ------------------
    h4 = doc.add_heading(level=1)
    r4 = h4.add_run("4. Day-Count Conventions: Calendar Days vs Flat 30-Day Model")
    r4.font.color.rgb = PRIMARY
    r4.font.bold = True

    doc.add_paragraph(
        "A critical operational detail in the Spiro Lease program is the day-count convention used to divide the Monthly Amount Due into the Daily Wallet Deduction:"
    )

    day_table = doc.add_table(rows=3, cols=3)
    day_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    day_table.autofit = False
    d_widths = [Inches(1.8), Inches(2.3), Inches(2.4)]

    d_headers = ["Day-Count Model", "Daily Calculation Formula", "Operational Characteristics"]
    for i, h in enumerate(d_headers):
        cell = day_table.cell(0, i)
        cell.width = d_widths[i]
        set_cell_background(cell, "1E295D")
        set_cell_margins(cell, 100, 100, 100, 100)
        p = cell.paragraphs[0]
        run = p.add_run(h)
        run.font.bold = True
        run.font.size = Pt(9)
        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

    models_data = [
        ("Current Model:\nReal Calendar Days", "Daily = Month Due ÷ Actual Days in Calendar Month (28, 29, 30, or 31)", "• Exactly matches the live Gregorian calendar in Kampala (EAT).\n• 31-day months divide by 31; 28-day Feb divides by 28.\n• 12 months = exactly 365 days.\n• Daily amount fluctuates slightly depending on calendar days."),
        ("Standardized Model:\nFlat 30-Day Month", "Daily = Month Due ÷ 30 (Uniform 30 days per month)", "• Aligns bike leases with Welile Agent Advances and Rent Plans (both operate on fixed 30-day tenors).\n• Predictable and consistent daily rate throughout each month.\n• 12 months = exactly 360 days."),
    ]

    for row_idx, (m_name, m_form, m_char) in enumerate(models_data, start=1):
        bg = "FFFFFF" if row_idx == 1 else "F8FAFC"
        for col_idx, text in enumerate([m_name, m_form, m_char]):
            cell = day_table.cell(row_idx, col_idx)
            cell.width = d_widths[col_idx]
            set_cell_background(cell, bg)
            set_cell_margins(cell, 100, 100, 100, 100)
            p = cell.paragraphs[0]
            r = p.add_run(text)
            r.font.size = Pt(8.5)
            if col_idx == 0:
                r.font.bold = True
                r.font.color.rgb = PRIMARY

    doc.add_paragraph() # Spacer

    # ------------------ SECTION 5: DAILY WALLET SWEEP MECHANICS ------------------
    h5 = doc.add_heading(level=1)
    r5 = h5.add_run("5. Daily Wallet Sweep Recovery Engine (Technical Architecture)")
    r5.font.color.rgb = PRIMARY
    r5.font.bold = True

    doc.add_paragraph(
        "All bike lease repayments are recovered automatically from active agents via background automated sweeps executed by PostgreSQL's `pg_cron` extension calling the database function `public.recover_merchandise_from_wallets()`."
    )

    doc.add_paragraph("Key Operational Rules of the Sweep Engine:", style='List Bullet')
    doc.add_paragraph("1. Schedule: Runs 4 times daily at 05:00, 11:00, 17:00, and 23:00 UTC (corresponding to 08:00 AM, 02:00 PM, 08:00 PM, and 02:00 AM in Kampala, EAT).", style='List Bullet 2')
    doc.add_paragraph("2. 1-Sweep Daily Limit: For Spiro bike plans, the system enforces a strict cap of at most one successful recovery per Kampala calendar day (guaranteed via `last_bike_recovery_on = today` check).", style='List Bullet 2')
    doc.add_paragraph("3. 24-Hour Interval: An agent who is successfully swept at 08:00 AM is locked for the remainder of that calendar day and will not be swept again until 08:00 AM the following morning (~24 hours later).", style='List Bullet 2')
    doc.add_paragraph("4. Retry on Zero/Partial Balance: If an agent has UGX 0 in their wallet during the 08:00 AM sweep, no deduction occurs. When they collect rent and earn commission during the day, the 02:00 PM or 08:00 PM cron run will collect that day's installment.", style='List Bullet 2')
    doc.add_paragraph("5. No Wallet Overdraft: Deductions are strictly limited to withdrawable commission funds (`LEAST(outstanding, available, daily_cap)`). The system never overdrafts an agent wallet into a negative balance.", style='List Bullet 2')

    doc.add_paragraph()

    # ------------------ SECTION 6: DOUBLE-ENTRY LEDGER ACCOUNTING ------------------
    h6 = doc.add_heading(level=1)
    r6 = h6.add_run("6. Double-Entry General Ledger Accounting")
    r6.font.color.rgb = PRIMARY
    r6.font.bold = True

    doc.add_paragraph(
        "Every single recovery sweep creates atomic, balanced double-entry transactions in `general_ledger` using the canonical Welile posting model:"
    )

    ledger_table = doc.add_table(rows=4, cols=4)
    ledger_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    ledger_table.autofit = False
    l_widths = [Inches(1.5), Inches(1.5), Inches(1.5), Inches(2.0)]

    l_headers = ["Transaction Leg", "Scope & Direction", "Ledger Category", "Accounting Purpose"]
    for i, h in enumerate(l_headers):
        cell = ledger_table.cell(0, i)
        cell.width = l_widths[i]
        set_cell_background(cell, "1E295D")
        set_cell_margins(cell, 100, 100, 100, 100)
        p = cell.paragraphs[0]
        run = p.add_run(h)
        run.font.bold = True
        run.font.size = Pt(9)
        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

    ledger_data = [
        ("Agent Wallet Debit", "Scope: Wallet\nDirection: CASH_OUT\nBucket: Withdrawable", "agent_repayment", "Deducts installment from agent's withdrawable commission balance."),
        ("Company Principal Credit", "Scope: Platform\nDirection: CASH_IN\nTarget: Operational Wallet", "bike_recovery_repayment", "Credits recovered bike principal back into company operational float (Balance Sheet Asset recovery)."),
        ("Access Fee Revenue", "Scope: Platform\nDirection: CASH_IN\nTarget: Operational Wallet", "access_fee_collected", "Records the 28% facility fee as recognized company operational income."),
    ]

    for row_idx, (leg, scope, cat, purp) in enumerate(ledger_data, start=1):
        bg = "FFFFFF" if row_idx % 2 != 0 else "F8FAFC"
        for col_idx, text in enumerate([leg, scope, cat, purp]):
            cell = ledger_table.cell(row_idx, col_idx)
            cell.width = l_widths[col_idx]
            set_cell_background(cell, bg)
            set_cell_margins(cell, 90, 90, 100, 100)
            p = cell.paragraphs[0]
            r = p.add_run(text)
            r.font.size = Pt(8.5)
            if col_idx == 0:
                r.font.bold = True
                r.font.color.rgb = PRIMARY

    doc.add_paragraph() # Spacer

    # ------------------ SECTION 7: FULL SETTLEMENT & LOGBOOK TITLE DISCHARGE ------------------
    h7 = doc.add_heading(level=1)
    r7 = h7.add_run("7. Full Settlement, Certificate Issuance & Legal Title Transfer")
    r7.font.color.rgb = PRIMARY
    r7.font.bold = True

    doc.add_paragraph(
        "Upon completion of the final repayment instalment, the following automated settlement protocol triggers:"
    )

    doc.add_paragraph(
        "1. Automatic Balance Clearance: When `outstanding_balance` reaches UGX 0, the plan is updated to `status = 'completed'` and `completed_at = now()`. The application lock is automatically released, allowing the agent to apply for subsequent assets.",
        style='List Bullet'
    )
    doc.add_paragraph(
        "2. Certificate of Full Settlement Generation: The system dynamically renders a formal legal PDF certificate (`generateSpiroBikeSettlementCertificatePdf`) detailing the Agent Name, NIN, Phone, Bike Model, Tracking Reference, Chassis Number, Total Amount Repaid, and Digital COO/CFO Discharge Seal.",
        style='List Bullet'
    )
    doc.add_paragraph(
        "3. Legal Custody Discharge: Welile Legal Operations executes the physical discharge of the Spiro logbook from company custody and initiates official ownership transfer with the Uganda Revenue Authority (URA).",
        style='List Bullet'
    )

    doc.add_paragraph()

    # Signoff Block
    sign_table = doc.add_table(rows=2, cols=3)
    sign_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    sign_table.columns[0].width = Inches(2.1)
    sign_table.columns[1].width = Inches(2.1)
    sign_table.columns[2].width = Inches(2.1)

    roles = ["Chief Operating Officer (COO)", "Chief Financial Officer (CFO)", "Head of Agent Operations"]
    for i, role in enumerate(roles):
        cell_top = sign_table.cell(0, i)
        set_cell_background(cell_top, "F1F5F9")
        set_cell_margins(cell_top, 100, 100, 100, 100)
        p1 = cell_top.paragraphs[0]
        r = p1.add_run(f"APPROVED BY:\n\n_________________________\n{role}")
        r.font.size = Pt(9)
        r.font.bold = True
        r.font.color.rgb = PRIMARY

        cell_bot = sign_table.cell(1, i)
        set_cell_background(cell_bot, "FFFFFF")
        set_cell_margins(cell_bot, 60, 60, 100, 100)
        p2 = cell_bot.paragraphs[0]
        r2 = p2.add_run("Date: October 2026\nWelile Technologies Ltd")
        r2.font.size = Pt(8)
        r2.font.color.rgb = MUTED

    # Output file
    output_path = "/Users/djshirleybeats/Desktop/welilereceipts-com-98bba33b/Welile_Spiro_Bike_Lease_Process_Document.docx"
    doc.save(output_path)
    print(f"Document successfully created at: {output_path}")

if __name__ == "__main__":
    create_document()
