import { useRef, useState } from 'react';
import { DirectPayStartButton } from '@/components/direct-pay/DirectPayPartner';
import { useQuery } from '@tanstack/react-query';
import { Banknote, Building2, Check, Copy, Loader2, Phone, Smartphone, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';
import mtnLogoAsset from '@/assets/mtn-logo.png.asset.json';
import airtelLogoAsset from '@/assets/airtel-logo.png.asset.json';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { useIsMobile } from '@/hooks/use-mobile';
import { useSelfSupportFeePolicy } from '@/hooks/useSelfSupportFeePolicy';
import { welileCoverSentence } from '@/lib/selfSupportFee';
import {
  SUPPORT_CALL_URL,
  fetchLandlordPayoutContact,
  recordOffplatformRentPayment,
  supportWhatsAppUrl,
  uploadCashReceiptPhoto,
  type LandlordPayoutContact,
} from '@/lib/funderFundChoice';

export interface FundChoiceTarget {
  rentRequestId: string;
  title: string;
  place: string;
  landlordName: string | null;
  /** Rent on the plan, used to show Welile Cover before the partner types an amount. */
  rentAmount?: number | null;
}

type Step = 'choose' | 'momo' | 'cash' | 'saved';

type Choice = 'welile' | 'momo' | 'cash' | 'support';

/** Network logo tile, same style as the wallet hub's provider logos. */
function ProviderLogo({ src }: { src: string }) {
  return (
    <span className="grid h-7 w-7 flex-none place-items-center overflow-hidden rounded-lg border border-border/60 bg-background">
      <img src={src} alt="" aria-hidden className="h-full w-full object-contain p-0.5" loading="lazy" />
    </span>
  );
}

/** One option card with a checkbox; tapping ticks it, and Continue acts on the ticked one. */
function ChoiceButton({ title, detail, checked, onClick, icon }: { title: string; detail: string; checked: boolean; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-3 rounded-2xl border bg-card px-3 py-3 text-left transition-colors active:scale-[0.99]',
        checked ? 'border-primary ring-1 ring-primary' : 'border-border/70',
      )}
    >
      <span className="grid h-10 w-10 flex-none place-items-center rounded-full bg-primary/10 text-primary">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{detail}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          'mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-md border-2 transition-colors',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40 bg-background',
        )}
      >
        {checked ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : null}
      </span>
    </button>
  );
}

function ChooserBody({
  target,
  onThroughWelile,
  onClose,
}: {
  target: FundChoiceTarget;
  onThroughWelile: () => void;
  onClose: () => void;
}) {
  const contactQuery = useQuery({
    queryKey: ['funder-payout-contact', target.rentRequestId],
    queryFn: () => fetchLandlordPayoutContact(target.rentRequestId),
    staleTime: 60_000,
    retry: false,
  });
  const contact = contactQuery.data?.state === 'ready' ? contactQuery.data.contact : null;
  const showDirect = Boolean(contact?.payoutMomoNumber || contact?.landlordPhone);
  const [step, setStep] = useState<Step>('choose');
  const [choice, setChoice] = useState<Choice | null>(null);
  const [amount, setAmount] = useState('');
  const [provider, setProvider] = useState<'mtn' | 'airtel' | ''>('');
  const [reference, setReference] = useState('');
  const [when, setWhen] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const { policy } = useSelfSupportFeePolicy();
  const planCover = welileCoverSentence(Number(target.rentAmount || 0), policy);
  const typedCover = welileCoverSentence(Number(amount), policy);

  const copyNumber = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Number copied');
    } catch {
      toast.error('Could not copy the number');
    }
  };

  const save = async (method: 'mobile_money' | 'cash') => {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error('Enter the amount you paid');
      return;
    }
    if (method === 'mobile_money' && (!provider || !reference.trim())) {
      toast.error('Choose MTN or Airtel and enter the TID');
      return;
    }
    setBusy(true);
    try {
      let photoPath: string | null = null;
      if (method === 'cash' && photo) {
        photoPath = await uploadCashReceiptPhoto(target.rentRequestId, photo);
        if (!photoPath) toast.message('The receipt photo was not saved. The cash payment can still be recorded.');
      }
      const result = await recordOffplatformRentPayment({
        rentRequestId: target.rentRequestId,
        method,
        amount: parsed,
        provider: method === 'mobile_money' ? provider || null : null,
        reference: method === 'mobile_money' ? reference.trim() : null,
        paidAt: when ? new Date(when).toISOString() : new Date().toISOString(),
        receiptPhotoPath: photoPath,
      });
      if (!result.ok) {
        toast.error(("missing" in result && result.missing)
          ? 'Welile cannot record this payment yet. Nothing was saved and your balance was not charged.'
          : 'This payment was not recorded. Your balance was not charged.');
        return;
      }
      setStep('saved');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'saved') {
    return (
      <div className="space-y-3">
        <p className="text-sm font-semibold">Recorded as pending</p>
        <p className="text-sm text-muted-foreground">
          Welile will confirm this payment. The rent was not taken from your balance. Any Welile Cover is taken from your wallet only after that confirmation.
        </p>
        <Button className="h-11 w-full rounded-xl" onClick={onClose}>Done</Button>
      </div>
    );
  }

  if (step === 'momo' && contact) return (
    <MomoForm
      contact={contact}
      amount={amount}
      provider={provider}
      reference={reference}
      when={when}
      busy={busy}
      onAmount={setAmount}
      onProvider={setProvider}
      onReference={setReference}
      onWhen={setWhen}
      onCopy={() => contact.payoutMomoNumber && void copyNumber(contact.payoutMomoNumber)}
      coverSentence={typedCover}
      onBack={() => setStep('choose')}
      onSave={() => void save('mobile_money')}
    />
  );

  if (step === 'cash' && contact) return (
    <CashForm
      contact={contact}
      place={target.place}
      amount={amount}
      when={when}
      busy={busy}
      onAmount={setAmount}
      onWhen={setWhen}
      onPhoto={setPhoto}
      coverSentence={typedCover}
      onBack={() => setStep('choose')}
      onSave={() => void save('cash')}
    />
  );

  const proceed = () => {
    if (choice === 'welile') { onClose(); onThroughWelile(); }
    else if (choice === 'momo') setStep('momo');
    else if (choice === 'cash') setStep('cash');
  };

  return (
    <div className="space-y-2" role="radiogroup" aria-label="How to fund this house">
      <ChoiceButton
        icon={<Wallet className="h-5 w-5" />}
        title="Fund this house through Welile agent"
        detail="The rent goes straight to the agent's landlord float. The agent pays the landlord within 24 hours. You will see the rent and the 2% Welile Cover before your balance is used."
        checked={choice === 'welile'}
        onClick={() => setChoice('welile')}
      />
      {contactQuery.isLoading && (
        <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking verification</p>
      )}
      <DirectPayStartButton rentRequestId={target.rentRequestId} />
      {showDirect && contact?.payoutMomoNumber && (
        <ChoiceButton
          icon={<Smartphone className="h-5 w-5" />}
          title="Send directly to the landlord's mobile money"
          detail={planCover || 'You pay the landlord yourself. Welile records it as pending and does not charge your balance.'}
          checked={choice === 'momo'}
          onClick={() => setChoice('momo')}
        />
      )}
      {showDirect && contact?.landlordPhone && (
        <ChoiceButton
          icon={<Banknote className="h-5 w-5" />}
          title="Take cash to the landlord"
          detail={planCover || 'You hand the landlord the cash. Welile records it as pending and does not charge your balance.'}
          checked={choice === 'cash'}
          onClick={() => setChoice('cash')}
        />
      )}
      {!contactQuery.isLoading && !showDirect && (
        <p className="px-1 text-xs text-muted-foreground">
          Direct mobile money and cash show here after this Rent Plan is verified.
        </p>
      )}
      <ChoiceButton
        icon={<Building2 className="h-5 w-5" />}
        title="Contact Welile Tenant Partnership Support Team"
        detail="WhatsApp or call Welile Customer Care to fund this house through Welile."
        checked={choice === 'support'}
        onClick={() => setChoice('support')}
      />
      {/* The support card keeps its WhatsApp / Call pair; every other choice goes through Continue. */}
      {choice !== 'support' ? (
        <Button className="h-11 w-full rounded-xl" disabled={!choice} onClick={proceed}>
          Continue
        </Button>
      ) : (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button asChild className="h-11 rounded-xl">
          <a href={supportWhatsAppUrl(target)} target="_blank" rel="noopener noreferrer">WhatsApp Welile</a>
        </Button>
        <Button asChild variant="outline" className="h-11 rounded-xl">
          <a href={SUPPORT_CALL_URL}><Phone className="h-4 w-4" /> Call Welile</a>
        </Button>
      </div>
      )}
    </div>
  );
}

function MomoForm(props: {
  contact: LandlordPayoutContact;
  amount: string;
  provider: '' | 'mtn' | 'airtel';
  reference: string;
  when: string;
  busy: boolean;
  onAmount: (v: string) => void;
  onProvider: (v: 'mtn' | 'airtel') => void;
  onReference: (v: string) => void;
  onWhen: (v: string) => void;
  coverSentence: string | null;
  onCopy: () => void;
  onBack: () => void;
  onSave: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">{props.contact.landlordName}</p>
      <p className="text-sm">Mobile money: {props.contact.payoutMomoNumber || 'Not recorded'}</p>
      <p className="text-xs text-muted-foreground">Name on the account: {props.contact.payoutMomoName || 'Not recorded'}</p>
      {props.contact.payoutMomoNumber && (
        <Button type="button" variant="outline" className="h-11 w-full rounded-xl text-green-600 hover:text-green-700 dark:text-green-400" onClick={props.onCopy}>
          <Copy className="h-4 w-4" /> Copy number
        </Button>
      )}
      {props.coverSentence && <p className="text-xs text-muted-foreground">{props.coverSentence}</p>}
      <p className="text-xs text-muted-foreground">Recorded as pending until Welile confirms it. The rent is not taken from your balance.</p>
      <Input inputMode="decimal" placeholder="Amount in UGX" value={props.amount} onChange={(e) => props.onAmount(e.target.value)} className="h-11" />
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant={props.provider === 'mtn' ? 'default' : 'outline'} className="h-11" onClick={() => props.onProvider('mtn')}>
          <ProviderLogo src={mtnLogoAsset.url} /> MTN
        </Button>
        <Button type="button" variant={props.provider === 'airtel' ? 'default' : 'outline'} className="h-11" onClick={() => props.onProvider('airtel')}>
          <ProviderLogo src={airtelLogoAsset.url} /> Airtel
        </Button>
      </div>
      <Input placeholder="TID or reference" value={props.reference} onChange={(e) => props.onReference(e.target.value)} className="h-11" />
      <Input type="datetime-local" value={props.when} onChange={(e) => props.onWhen(e.target.value)} className="h-11" aria-label="Time you sent the money" />
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" className="h-11" onClick={props.onBack}>Back</Button>
        <Button type="button" className="h-11" disabled={props.busy} onClick={props.onSave}>{props.busy ? 'Saving' : 'Record payment'}</Button>
      </div>
    </div>
  );
}

function CashForm(props: {
  contact: LandlordPayoutContact;
  place: string;
  amount: string;
  when: string;
  busy: boolean;
  onAmount: (v: string) => void;
  onWhen: (v: string) => void;
  coverSentence: string | null;
  onPhoto: (file: File | null) => void;
  onBack: () => void;
  onSave: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">{props.contact.landlordName}</p>
      <p className="text-sm">Phone: {props.contact.landlordPhone || 'Not recorded'}</p>
      <p className="text-xs text-muted-foreground">{props.contact.location || props.place || 'Location not recorded'}</p>
      {props.coverSentence && <p className="text-xs text-muted-foreground">{props.coverSentence}</p>}
      <p className="text-xs text-muted-foreground">Recorded as pending until Welile confirms it. The rent is not taken from your balance.</p>
      <Input inputMode="decimal" placeholder="Amount in UGX" value={props.amount} onChange={(e) => props.onAmount(e.target.value)} className="h-11" />
      <Input type="date" value={props.when.slice(0, 10)} onChange={(e) => props.onWhen(e.target.value)} className="h-11" aria-label="Date you paid the landlord" />
      <label className="block text-xs text-muted-foreground">
        Photo of the landlord's signed receipt (optional)
        <Input type="file" accept="image/*" className="mt-1 h-11" onChange={(e) => props.onPhoto(e.target.files?.[0] ?? null)} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" className="h-11" onClick={props.onBack}>Back</Button>
        <Button type="button" className="h-11" disabled={props.busy} onClick={props.onSave}>{props.busy ? 'Saving' : 'Record payment'}</Button>
      </div>
    </div>
  );
}

export function FunderFundChooser({
  target,
  open,
  onOpenChange,
  onThroughWelile,
}: {
  target: FundChoiceTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onThroughWelile: (target: FundChoiceTarget) => void;
}) {
  const isMobile = useIsMobile();
  if (!target) return null;
  const title = 'How do you want to fund this house?';
  const body = (
    <ChooserBody
      key={target.rentRequestId}
      target={target}
      onClose={() => onOpenChange(false)}
      onThroughWelile={() => onThroughWelile(target)}
    />
  );
  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="max-h-[88vh] overflow-y-auto rounded-t-3xl">
          <SheetHeader><SheetTitle className="text-left">{title}</SheetTitle></SheetHeader>
          <div className="mt-3 pb-4">{body}</div>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

/** Opens the chooser before the existing Welile funding path. Deselect still happens immediately. */
export function useRentPlanFundChoice() {
  const [target, setTarget] = useState<FundChoiceTarget | null>(null);
  const [open, setOpen] = useState(false);
  const next = useRef<(() => void) | null>(null);
  const ask = (plan: FundChoiceTarget, onThroughWelile: () => void) => {
    next.current = onThroughWelile;
    setTarget(plan);
    setOpen(true);
  };
  const chooser = (
    <FunderFundChooser
      target={target}
      open={open}
      onOpenChange={setOpen}
      onThroughWelile={() => next.current?.()}
    />
  );
  return { ask, chooser };
}
