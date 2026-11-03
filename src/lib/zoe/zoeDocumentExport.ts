/**
 * Local client-side document export helpers for Zoe Drafting Mode (Part C item 7).
 * Generates local downloadable Word (.docx-compatible HTML/XML) and print-ready PDF documents
 * in the browser. Nothing is sent to any external server or recipient.
 */

export type ZoeDraftDocumentKind = "memo" | "sop" | "plan" | "email";

export interface ZoeDraftDocument {
  kind: ZoeDraftDocumentKind;
  title: string;
  body: string;
}

export function sanitizeDraftTerminology(text: string): string {
  return (text ?? "")
    .replace(/\bloans\b/gi, "Rent Plans")
    .replace(/\bloan\b/gi, "Rent Plan")
    .replace(/\blenders\b/gi, "Supporters")
    .replace(/\blender\b/gi, "Supporter")
    .replace(/\bROI\b/g, "Returns")
    .replace(/\binterest\s+rate\b/gi, "Access Fee rate");
}

export function generateDraftTemplate(
  kind: ZoeDraftDocumentKind,
  title: string,
  sourceNotes: string,
): string {
  const cleanTitle = sanitizeDraftTerminology(title.trim() || "Untitled Draft");
  const cleanNotes = sanitizeDraftTerminology(sourceNotes.trim());
  const today = new Date().toISOString().slice(0, 10);

  if (kind === "memo") {
    return [
      `# INTERNAL MEMORANDUM — ${cleanTitle}`,
      `**Date:** ${today}`,
      `**Organization:** Welile Technologies Limited`,
      `**Status:** Draft for Human Review (Not Sent)`,
      "",
      "## 1. Purpose",
      cleanNotes || "Summarize the operational objective and context for the team.",
      "",
      "## 2. Key Points & Evidence",
      "- Review verified Rent Plan, Supporter, or Returns figures from the official workspace screen.",
      "- Confirm ownership and next steps with the department lead.",
      "",
      "## 3. Action Items",
      "- [ ] Owner / Action / Target Date",
    ].join("\n");
  }

  if (kind === "sop") {
    return [
      `# STANDARD OPERATING PROCEDURE (SOP): ${cleanTitle}`,
      `**Effective Date:** ${today}`,
      `**Scope:** Welile Operations`,
      "",
      "## 1. Objective",
      cleanNotes || "Define the standard step-by-step workflow and verification controls.",
      "",
      "## 2. Preconditions & Required Roles",
      "- Verify staff role permissions on the corresponding Welile workspace screen.",
      "",
      "## 3. Step-by-Step Procedure",
      "1. Open the designated Welile workspace screen.",
      "2. Verify the record details and supporting evidence.",
      "3. Record the outcome and escalate any exceptions to the department lead.",
      "",
      "## 4. Quality & Audit Checks",
      "- Confirm all figures use Rent Plan, Supporter, and Returns terminology and UGX formatting.",
    ].join("\n");
  }

  if (kind === "plan") {
    return [
      `# WORK PLAN: ${cleanTitle}`,
      `**Date:** ${today}`,
      "",
      "## 1. Goal & Baseline",
      cleanNotes || "State the operational goal and current baseline metric.",
      "",
      "## 2. Milestones & Owners",
      "| Milestone | Owner | Target Date | Measure of Success |",
      "| --- | --- | --- | --- |",
      "| Step 1 | Department Lead | TBD | Verified on workspace report |",
      "",
      "## 3. Risks & Mitigations",
      "- Identify operational bottlenecks and how they will be tracked.",
    ].join("\n");
  }

  return [
    `Subject: ${cleanTitle}`,
    "",
    "Dear Colleague,",
    "",
    cleanNotes || "Please find the summary and next steps below for your review.",
    "",
    "Best regards,",
    "Welile Operations Team",
  ].join("\n");
}

export function exportDraftAsWordDoc(doc: ZoeDraftDocument): void {
  if (typeof window === "undefined") return;
  const safeTitle = sanitizeDraftTerminology(doc.title || "Welile-Draft");
  const safeBody = sanitizeDraftTerminology(doc.body || "");
  const htmlContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${safeTitle.replace(/[<>&]/g, "")}</title>
<style>
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #111827; margin: 24pt; }
  h1 { font-size: 16pt; margin-bottom: 8pt; color: #111827; }
  h2 { font-size: 13pt; margin-top: 14pt; margin-bottom: 6pt; color: #1f2937; }
  pre, p { white-space: pre-wrap; margin: 0 0 8pt 0; }
  .footer { margin-top: 24pt; font-size: 9pt; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 8pt; }
</style>
</head>
<body>
  <h1>${safeTitle.replace(/[<>&]/g, "")}</h1>
  <p>${safeBody.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
  <div class="footer">Prepared in Zoe Drafting Mode · Local draft for human review · Nothing sent automatically</div>
</body>
</html>`;

  const blob = new Blob([htmlContent], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const slug = safeTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  a.href = url;
  a.download = `${slug || "welile-draft"}.doc`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportDraftAsPrintablePdf(doc: ZoeDraftDocument): void {
  if (typeof window === "undefined") return;
  const safeTitle = sanitizeDraftTerminology(doc.title || "Welile Draft");
  const safeBody = sanitizeDraftTerminology(doc.body || "");
  const printWin = window.open("", "_blank", "noopener,noreferrer,width=800,height=900");
  if (!printWin) return;
  printWin.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${safeTitle.replace(/[<>&]/g, "")}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; font-size: 12pt; line-height: 1.55; color: #111827; padding: 32px; }
  h1 { font-size: 18pt; margin-bottom: 12px; }
  pre { font-family: inherit; white-space: pre-wrap; word-break: break-word; }
  .meta { font-size: 9pt; color: #6b7280; margin-top: 24px; border-top: 1px solid #d1d5db; padding-top: 8px; }
</style>
</head>
<body>
  <h1>${safeTitle.replace(/[<>&]/g, "")}</h1>
  <pre>${safeBody.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
  <div class="meta">Welile Technologies Limited · Local Draft (Not Sent)</div>
</body>
</html>`);
  printWin.document.close();
  printWin.focus();
  printWin.print();
}
