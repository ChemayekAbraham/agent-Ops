import { ArrowRight, Check, Clock, Home } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import type { CoSupportInviteCopy, CoSupportPreview } from '@/lib/coSupport';

export function CoSupportPerson({ src, alt, className = '' }: { src: string | null; alt?: string; className?: string }) {
  return <Avatar className={`border-2 border-card bg-muted ${className}`}>
    <AvatarImage src={src ?? undefined} alt={alt ?? ''} />
    <AvatarFallback className="items-end text-muted-foreground/60">
      <svg aria-hidden viewBox="0 0 24 24" className="h-5/6 w-5/6 fill-current"><circle cx="12" cy="9" r="4.2" /><path d="M3.5 23c0-4.7 3.8-8.2 8.5-8.2s8.5 3.5 8.5 8.2z" /></svg>
    </AvatarFallback>
  </Avatar>;
}

export function CoSupportHousePhoto({ preview, copy, small = false }: { preview: CoSupportPreview; copy: CoSupportInviteCopy; small?: boolean }) {
  return <div className={`overflow-hidden rounded-xl border border-border/60 bg-primary/5 ${small ? 'h-[52px] w-[52px] shrink-0' : 'h-[196px] w-full'}`}>
    {preview.house_image_url ? <img src={preview.house_image_url} alt={copy.photoAlt} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center"><Home className={`${small ? 'h-6 w-6' : 'h-12 w-12'} text-primary/45`} aria-hidden /></div>}
  </div>;
}

export function CoSupportInvitationHeader({ preview, copy, leadPhoto }: { preview: CoSupportPreview; copy: CoSupportInviteCopy; leadPhoto: string | null }) {
  return <>
    <div className="flex items-center gap-2.5">
      <CoSupportPerson src={leadPhoto} alt={copy.leadPhotoAlt} className="h-12 w-12 ring-2 ring-primary/35" />
      <div className="min-w-0"><p className="text-sm font-semibold">{copy.leadName}</p><p className="text-xs text-muted-foreground">{copy.leadTagline}</p></div>
    </div>
    <h1 className="text-[22px] font-bold leading-tight">{copy.headline}</h1>
    <CoSupportHousePhoto preview={preview} copy={copy} />
    {copy.houseLine ? <div><p className="text-sm font-semibold">{copy.houseLine}</p><p className="text-xs text-muted-foreground">{copy.houseSubLine}</p></div> : null}
    <p className="text-sm leading-relaxed text-muted-foreground">{copy.intro}</p>
    {preview.signed_in && preview.can_accept && copy.timeline.length ? <ol className="pt-1">
      {copy.timeline.map((step, index) => <li key={`${step.when}-${index}`} className="flex gap-3">
        <div className="flex w-4 shrink-0 flex-col items-center" aria-hidden>
          <span className={`mt-1 h-3.5 w-3.5 shrink-0 rounded-full ${step.tone === 'now' ? 'bg-primary ring-4 ring-primary/15' : step.tone === 'later' ? 'border-2 border-dashed border-primary/60' : 'border-2 border-primary'}`} />
          {index < copy.timeline.length - 1 ? <span className="my-1 w-0.5 flex-1 bg-primary/15" /> : null}
        </div>
        <div className={index < copy.timeline.length - 1 ? 'pb-4' : ''}>
          <p className={`text-xs font-semibold ${step.tone === 'now' ? 'text-primary' : 'text-muted-foreground'}`}>{step.when}</p>
          <p className="text-sm leading-relaxed">{step.text}{step.amount ? <> <strong className={`co-support-amount inline-block font-mono ${index > 1 ? 'text-primary' : ''}`}>{step.amount}</strong></> : null}</p>
        </div>
      </li>)}
    </ol> : <div className="flex items-center gap-2 border-y py-3.5">
      <div className="min-w-0 flex-1"><p className="co-support-amount font-mono text-base font-bold sm:text-lg">{copy.joinAmount}</p><p className="mt-0.5 text-xs text-muted-foreground">{copy.joinAmountLabel}</p></div>
      {preview.signed_in && copy.earningAmount ? <ArrowRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden /> : null}
      <div className="min-w-0 flex-1 text-right">{preview.signed_in && copy.earningAmount ? <><p className="co-support-amount font-mono text-base font-bold text-primary sm:text-lg">{copy.earningAmount}</p><p className="mt-0.5 text-xs text-muted-foreground">{copy.earningLabel}</p></> : !preview.signed_in ? <p className="text-xs leading-relaxed text-muted-foreground">{copy.earningSignedOut}</p> : null}</div>
    </div>}
    {copy.holdLine ? <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><Clock className="h-4 w-4 shrink-0" aria-hidden /><p>{copy.holdPrefix} <strong className="font-semibold text-foreground">{copy.holdTime}</strong></p></div> : null}
  </>;
}

export function CoSupportJoined({ preview, copy, leadPhoto, ownPhoto }: { preview: CoSupportPreview; copy: CoSupportInviteCopy; leadPhoto: string | null; ownPhoto: string | null }) {
  return <main className="co-support-page min-h-screen bg-muted/40 px-4 py-8 text-foreground">
    <div className="mx-auto flex w-full max-w-md flex-col gap-5">
      <section className="flex flex-col items-center gap-3.5 pt-2 text-center">
        <div className="relative h-[72px] w-[132px]">
          <CoSupportPerson src={leadPhoto} alt={copy.leadPhotoAlt} className="absolute left-0 top-0 h-[72px] w-[72px] shadow-sm" />
          <CoSupportPerson src={ownPhoto} className="absolute right-0 top-0 h-[72px] w-[72px] shadow-sm" />
          <span className="absolute -bottom-2 left-1/2 flex h-[34px] w-[34px] -translate-x-1/2 items-center justify-center rounded-full border-[3px] border-background bg-success text-success-foreground"><Check className="h-4 w-4" aria-hidden /></span>
        </div>
        <p className="mt-2.5 rounded-full bg-success/10 px-3 py-1 text-xs font-bold text-success">{copy.successPill}</p>
        <h1 className="text-2xl font-extrabold leading-tight">{copy.successTitle}</h1>
        <p className="max-w-[320px] text-sm leading-relaxed text-muted-foreground">{copy.successDetail}</p>
      </section>
      <section className="co-support-success-card space-y-3.5 rounded-[20px] p-[18px] shadow-lg">
        <div className="flex items-center gap-3"><CoSupportHousePhoto preview={preview} copy={copy} small /><div className="min-w-0"><p className="text-xs opacity-80">{copy.successCard.eyebrow}</p><h2 className="text-base font-bold">{copy.successCard.title}</h2></div></div>
        <div className="grid grid-cols-2 gap-3">
          <div><p className="text-xs opacity-80">{copy.successCard.putInLabel}</p><p className="co-support-amount mt-0.5 font-mono text-base font-bold">{copy.successCard.putIn}</p></div>
          {copy.successCard.earning ? <div><p className="text-xs opacity-80">{copy.earningLabel}</p><p className="co-support-amount mt-0.5 font-mono text-base font-bold">{copy.successCard.earning}</p></div> : null}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-primary-foreground/20 pt-3 text-[13px]"><span className="opacity-85">{copy.successCard.firstLabel}</span><strong className="text-right">{copy.successCard.first}</strong></div>
      </section>
      <section className="co-support-card space-y-3.5 rounded-2xl border border-border/60 bg-card p-4">
        <h2 className="text-[15px] font-bold">{copy.nextStepsTitle}</h2>
        <ol className="space-y-3.5">{copy.nextSteps.map((step, index) => <li key={step.title} className="flex gap-3">
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${step.done ? 'bg-success text-success-foreground' : 'border-2 border-primary text-primary'}`} aria-hidden>{step.done ? <Check className="h-3.5 w-3.5" /> : index + 1}</span>
          <div><p className="text-sm font-semibold">{step.title}</p><p className="text-xs leading-relaxed text-muted-foreground">{step.detail}</p></div>
        </li>)}</ol>
      </section>
      <div className="grid gap-2">
        <Button className="h-12 rounded-2xl text-[15px]" asChild><Link to="/dashboard/funder/portfolio">{copy.seePortfolioLabel}</Link></Button>
        <Button variant="secondary" className="h-12 rounded-2xl bg-primary/10 text-[15px] text-primary hover:bg-primary/15" asChild><Link to="/dashboard/funder">{copy.findAnotherLabel}</Link></Button>
      </div>
    </div>
  </main>;
}