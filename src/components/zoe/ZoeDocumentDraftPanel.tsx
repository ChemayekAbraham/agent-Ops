import React, { useState } from "react";
import { Check, Copy, FileDown, FileText, Printer, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  exportDraftAsPrintablePdf,
  exportDraftAsWordDoc,
  generateDraftTemplate,
  sanitizeDraftTerminology,
  type ZoeDraftDocumentKind,
} from "@/lib/zoe/zoeDocumentExport";

export interface ZoeDocumentDraftPanelProps {
  open: boolean;
  initialText?: string;
  initialTitle?: string;
  onClose: () => void;
  onAskZoeToRefine?: (prompt: string) => void;
}

const DRAFT_KIND_OPTIONS: Array<{ id: ZoeDraftDocumentKind; label: string }> = [
  { id: "memo", label: "Memo" },
  { id: "sop", label: "SOP" },
  { id: "plan", label: "Work Plan" },
  { id: "email", label: "Email Text" },
];

export const ZoeDocumentDraftPanel: React.FC<ZoeDocumentDraftPanelProps> = ({
  open,
  initialText = "",
  initialTitle = "Operational Draft",
  onClose,
  onAskZoeToRefine,
}) => {
  const [kind, setKind] = useState<ZoeDraftDocumentKind>("memo");
  const [title, setTitle] = useState(initialTitle);
  const [pastedNotes, setPastedNotes] = useState("");
  const [draftBody, setDraftBody] = useState(() =>
    initialText
      ? sanitizeDraftTerminology(initialText)
      : generateDraftTemplate("memo", initialTitle, ""),
  );
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  const handleBuildFromNotes = () => {
    const built = generateDraftTemplate(kind, title, pastedNotes);
    setDraftBody(built);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sanitizeDraftTerminology(draftBody));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore clipboard failure
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[440px] sm:border-l sm:border-border sm:shadow-xl"
      data-testid="zoe-document-draft-panel"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" />
          <div>
            <h3 className="text-sm font-semibold text-foreground">Drafting Mode</h3>
            <p className="text-xs text-muted-foreground">
              Local editor for memos, SOPs, plans & emails — nothing is sent anywhere
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="min-h-[44px] min-w-[44px]"
          aria-label="Close drafting panel"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Document type">
          {DRAFT_KIND_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                setKind(opt.id);
                setDraftBody(generateDraftTemplate(opt.id, title, pastedNotes));
              }}
              className={`min-h-[44px] rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                kind === opt.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground" htmlFor="zoe-draft-title">
            Document Title
          </label>
          <input
            id="zoe-draft-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Weekly Rent Plan Collection Follow-Up"
            className="min-h-[44px] w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-foreground" htmlFor="zoe-draft-notes">
              Paste source notes or bullet points
            </label>
            <button
              type="button"
              onClick={handleBuildFromNotes}
              className="min-h-[44px] px-2 text-xs font-medium text-primary hover:underline"
            >
              Apply to template
            </button>
          </div>
          <textarea
            id="zoe-draft-notes"
            rows={3}
            value={pastedNotes}
            onChange={(e) => setPastedNotes(e.target.value)}
            placeholder="Paste rough notes here to structure into a clean Welile document..."
            className="w-full rounded-md border border-input bg-background p-2.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground" htmlFor="zoe-draft-editor">
            Document Content (editable)
          </label>
          <textarea
            id="zoe-draft-editor"
            rows={12}
            value={draftBody}
            onChange={(e) => setDraftBody(sanitizeDraftTerminology(e.target.value))}
            className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/30 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopy}
            className="min-h-[44px] gap-1.5 text-xs"
            data-testid="zoe-draft-copy-btn"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => exportDraftAsWordDoc({ kind, title, body: draftBody })}
            className="min-h-[44px] gap-1.5 text-xs"
            data-testid="zoe-draft-word-btn"
          >
            <FileDown className="h-3.5 w-3.5" />
            Word (.doc)
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => exportDraftAsPrintablePdf({ kind, title, body: draftBody })}
            className="min-h-[44px] gap-1.5 text-xs"
            data-testid="zoe-draft-pdf-btn"
          >
            <Printer className="h-3.5 w-3.5" />
            PDF
          </Button>
        </div>

        {onAskZoeToRefine && (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              onAskZoeToRefine(
                `Please polish this ${kind.toUpperCase()} draft titled "${title}" using Welile regulatory terminology (Rent Plan, Supporter, Returns):\n\n${draftBody.slice(0, 1400)}`,
              );
              onClose();
            }}
            className="min-h-[44px] gap-1.5 text-xs"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Ask Zoe to Polish
          </Button>
        )}
      </div>
    </div>
  );
};
