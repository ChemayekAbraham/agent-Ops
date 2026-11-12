import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Upload } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Self-pay landlord payout (allow-listed agents only): the money already came
 * out of the agent's Landlord Float on the server. The agent sends it to the
 * landlord himself, then records the transaction ID and a receipt photo.
 * The server decides everything; this form only submits the evidence.
 */
export function LandlordSelfPayReceiptForm({ payoutId, onSubmitted }: { payoutId: string; onSubmitted?: () => void }) {
  const [tid, setTid] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const tidOk = tid.trim().length >= 6;

  const submit = async () => {
    if (!tidOk || !file) return;
    setBusy(true);
    try {
      const ext = file.name.split(".").pop() || "jpg";
      const path = `landlord-self-pay/${payoutId}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("receipts").upload(path, file);
      if (upErr) throw upErr;
      const { data: urlData } = supabase.storage.from("receipts").getPublicUrl(path);
      const { data, error } = await supabase.functions.invoke("submit-landlord-payout-receipt", {
        body: { payout_id: payoutId, receipt_number: tid.trim(), receipt_image_url: urlData.publicUrl },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success("Landlord payment recorded");
      onSubmitted?.();
    } catch (e: any) {
      toast.error(e?.message ?? "Could not record the payment");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-left space-y-3">
      <p className="text-xs font-semibold text-foreground">Send the money to the landlord yourself</p>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        This amount came from your Landlord Float. Your wallet balance was not touched. After you send it, enter the transaction ID and upload the receipt.
      </p>
      <div className="space-y-1">
        <Label htmlFor="self-pay-tid" className="text-xs">Transaction ID</Label>
        <Input id="self-pay-tid" value={tid} onChange={(e) => setTid(e.target.value)} placeholder="At least 6 characters" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="self-pay-receipt" className="text-xs">Receipt photo</Label>
        <Input id="self-pay-receipt" type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <Button size="sm" className="w-full" disabled={!tidOk || !file || busy} onClick={submit}>
        {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1.5" />}
        Record landlord payment
      </Button>
    </div>
  );
}
