import { useCallback, useEffect, useRef, useState, type KeyboardEvent as RKE, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ArrowLeft, ArrowRight, User, Users, X } from 'lucide-react';
import s from './WelcomeNew.module.css';
import logoA from '@/assets/welcome-new/welile-logo.png.asset.json';
import familyA from '@/assets/welcome-new/welcome-family.png.asset.json';
import hubA from '@/assets/welcome-new/ecosystem-hub.png.asset.json';
import tenantA from '@/assets/welcome-new/tenant.png.asset.json';
import landlordA from '@/assets/welcome-new/landlord.png.asset.json';
import agentA from '@/assets/welcome-new/agent.png.asset.json';
import partnerA from '@/assets/welcome-new/partner.png.asset.json';
import houseA from '@/assets/welcome-new/role-landlord-house.png.asset.json';
import heartA from '@/assets/welcome-new/role-supporter-heart.png.asset.json';

// Existing auth routes in this app.
const SIGN_IN = '/auth';
const signUp = (role: string) => `/auth?signup=1&role=${role}`;

type Slide = { img: string; alt: string; heading: string; sub: string; contain?: boolean };
const SLIDES: Slide[] = [
  { img: hubA.url, alt: 'Diagram linking Tenants, Landlords, Agents and Supporters', heading: 'Making rent work for everyone', sub: 'Welile connects tenants, landlords, agents and supporters through one trusted platform.', contain: true },
  { img: tenantA.url, alt: 'A woman relaxing on a sofa using her phone', heading: 'For Tenants', sub: 'Request rent support, manage repayments and follow your progress with ease.' },
  { img: landlordA.url, alt: 'A landlord with a tablet outside apartments', heading: 'For Landlords', sub: 'List properties, manage tenants and track rent activity from one place.' },
  { img: agentA.url, alt: 'A Welile agent in a purple suit', heading: 'For Agents', sub: 'Connect people, support onboarding and grow through field opportunities.' },
  { img: partnerA.url, alt: 'A supporter in a purple polo shirt', heading: 'For Partners', sub: 'Support rent opportunities, monitor portfolios and help make housing possible.' },
];

type RoleId = 'tenant' | 'landlord' | 'agent' | 'supporter';
const ROLES: { id: RoleId; name: string; desc: string; bg: string; icon: ReactNode }[] = [
  { id: 'tenant', name: 'Tenant', desc: 'Find a home, pay rent and access support', bg: '#f4effe', icon: <User size={22} color="#7a38e8" aria-hidden /> },
  { id: 'landlord', name: 'Landlord', desc: 'List properties, manage tenants and grow your income', bg: '#fef3c7', icon: <img src={houseA.url} alt="" /> },
  { id: 'agent', name: 'Agent', desc: 'Connect people, manage listings and close deals', bg: '#eff6ff', icon: <Users size={22} color="#2563eb" aria-hidden /> },
  { id: 'supporter', name: 'Supporter', desc: 'Support tenants and communities through funding and services', bg: '#fdf2f8', icon: <img src={heartA.url} alt="" /> },
];

const LAST = 6; // screens 0..6
const artLeft = (i: number) => i % 2 === 0; // screens 1,3,5,7 (0-indexed 0,2,4,6)

function Footer() {
  return (
    <div className={s.footer}>
      <a href="/privacy-policy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
      <span aria-hidden>|</span>
      <a href="#" onClick={(e) => e.preventDefault()}>Terms of Service</a>
    </div>
  );
}

function Dots({ count, active }: { count: number; active: number }) {
  return (
    <div className={s.dots} aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <span key={i} className={`${s.dot} ${i === active ? s.dotActive : ''}`} />
      ))}
    </div>
  );
}

export default function WelcomeNew() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const parsed = Number(params.get('step'));
  const step = Number.isFinite(parsed) && parsed >= 1 && parsed <= 7 ? parsed - 1 : 0;
  const [role, setRole] = useState<RoleId>('tenant');
  const [redirect, setRedirect] = useState<null | { to: string; label: string }>(null);
  const [count, setCount] = useState(5);
  const headings = useRef<(HTMLHeadingElement | null)[]>([]);
  const continueRef = useRef<HTMLButtonElement>(null);
  const goNowRef = useRef<HTMLButtonElement>(null);
  const roleRefs = useRef<(HTMLDivElement | null)[]>([]);
  const firstRender = useRef(true);
  const touchX = useRef<number | null>(null);

  const go = useCallback((n: number) => {
    const c = Math.max(0, Math.min(LAST, n));
    const next = new URLSearchParams(params);
    if (c === 0) next.delete('step'); else next.set('step', String(c + 1));
    setParams(next);
  }, [params, setParams]);

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    headings.current[step]?.focus({ preventScroll: true });
  }, [step]);

  // Arrow keys on screens 1-6
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (redirect || step >= LAST) return;
      const t = e.target as HTMLElement;
      if (t && ['INPUT', 'TEXTAREA'].includes(t.tagName)) return;
      if (e.key === 'ArrowRight') go(step + 1);
      if (e.key === 'ArrowLeft' && step > 0) go(step - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, go, redirect]);

  // Redirect countdown
  useEffect(() => {
    if (!redirect) return;
    goNowRef.current?.focus();
    if (count <= 0) { navigate(redirect.to); return; }
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [redirect, count, navigate]);

  const closeDialog = useCallback(() => {
    setRedirect(null);
    setTimeout(() => continueRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!redirect) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog();
      if (e.key === 'Tab') {
        const els = document.querySelectorAll<HTMLElement>('[data-wn-dialog] button');
        if (!els.length) return;
        const first = els[0], last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [redirect, closeDialog]);

  const onContinue = () => {
    if (role === 'tenant') { setCount(5); setRedirect({ to: '/n/tenants', label: 'Welile for Tenants' }); }
    else if (role === 'supporter') { setCount(5); setRedirect({ to: '/n/partner', label: 'Welile for Partners' }); }
    else navigate(signUp(role));
  };

  const onRoleKey = (e: RKE<HTMLDivElement>, i: number) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setRole(ROLES[i].id); }
    if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      const n = (i + d + ROLES.length) % ROLES.length;
      setRole(ROLES[n].id); roleRefs.current[n]?.focus();
    }
  };

  const pos = (i: number) => {
    if (i === step) return s.active;
    if (i < step) return s.before;
    return `${s.after} ${i > step + 1 ? s.farAfter : ''}`;
  };
  const side = (i: number) => (artLeft(i) ? s.artLeft : s.artRight);
  const inertProps = (i: number) => (i !== step || redirect ? { inert: '' as unknown as boolean, 'aria-hidden': true } : {});

  const topBar = (back: number, skip: boolean) => (
    <div className={s.topBar}>
      <button type="button" className={s.backBtn} aria-label="Back" onClick={() => go(back)}><ArrowLeft size={20} /></button>
      {skip && <button type="button" className={s.skipBtn} onClick={() => go(LAST)}>Skip</button>}
    </div>
  );

  return (
    <>
      <Helmet>
        <title>Welile — Housing &amp; Funding for Everyone</title>
        <meta name="description" content="Meet the four Welile roles — Tenant, Funder, Agent, Landlord — and pick the one that fits you." />
        <link rel="canonical" href="https://welileapp.com/welcome" />
        <meta property="og:title" content="Welile — Housing &amp; Funding for Everyone" />
        <meta property="og:description" content="Meet the four Welile roles — Tenant, Funder, Agent, Landlord — and pick the one that fits you." />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://welileapp.com/welcome" />
        <meta name="twitter:card" content="summary" />
      </Helmet>
      <div
      className={s.root}
      onTouchStart={(e) => { touchX.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        if (touchX.current == null || step >= LAST || redirect) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        if (dx < -50) go(step + 1);
        else if (dx > 50 && step > 0) go(step - 1);
      }}
    >
      <main className={s.frame} {...(redirect ? { inert: '' as unknown as boolean } : {})}>
        {/* Screen 1 */}
        <section className={`${s.screen} ${pos(0)} ${side(0)}`} aria-labelledby="wn-h-0" {...inertProps(0)}>
          <div className={s.hero}>
            <img className={s.heroImg} src={familyA.url} alt="A smiling family in front of a modern home" />
            <img className={s.logo} src={logoA.url} alt="Welile" />
          </div>
          <div className={s.card}>
            <div className={s.inner}>
              <h1 id="wn-h-0" tabIndex={-1} ref={(el) => (headings.current[0] = el)} className={s.heading}>
                Welcome to <span className={s.chewy}>Welile</span>
              </h1>
              <p className={s.subtitle}>Where homes meet opportunity.</p>
              <Dots count={4} active={0} />
              <button type="button" className={s.primary} onClick={() => go(1)}>Get Started <ArrowRight size={18} aria-hidden /></button>
              <button type="button" className={s.textLink} onClick={() => navigate(SIGN_IN)}>Sign in</button>
            </div>
            <Footer />
          </div>
        </section>

        {/* Screens 2-6 */}
        {SLIDES.map((sl, k) => {
          const i = k + 1;
          return (
            <section key={i} className={`${s.screen} ${pos(i)} ${side(i)}`} aria-labelledby={`wn-h-${i}`} {...inertProps(i)}>
              {topBar(i - 1, true)}
              <div className={`${s.hero} ${sl.contain ? s.heroContain : ''}`}>
                <img className={s.heroImg} src={sl.img} alt={sl.alt} />
              </div>
              <div className={s.card}>
                <div className={s.inner}>
                  <h2 id={`wn-h-${i}`} tabIndex={-1} ref={(el) => (headings.current[i] = el)} className={s.heading}>{sl.heading}</h2>
                  <p className={s.subtitle}>{sl.sub}</p>
                  <div className={s.progress}>
                    <Dots count={6} active={k} />
                    <span className={s.stepLabel}>{k + 1} of 6</span>
                  </div>
                  <button type="button" className={s.primary} onClick={() => go(i + 1)}>Next <ArrowRight size={18} aria-hidden /></button>
                </div>
                <Footer />
              </div>
            </section>
          );
        })}

        {/* Screen 7 */}
        <section className={`${s.screen} ${s.roleScreen} ${pos(LAST)} ${side(LAST)}`} aria-labelledby={`wn-h-${LAST}`} {...inertProps(LAST)}>
          <div className={s.roleArt}><img src={hubA.url} alt="" /></div>
          <div className={s.roleCol}>
            {topBar(LAST - 1, false)}
            <div className={s.roleHead}>
              <h2 id={`wn-h-${LAST}`} tabIndex={-1} ref={(el) => (headings.current[LAST] = el)} className={s.heading}>How will you use Welile?</h2>
              <p className={s.subtitle}>Your role helps personalize your experience.</p>
            </div>
            <div className={s.progress}><Dots count={6} active={5} /><span className={s.stepLabel}>6 of 6</span></div>
            <div className={s.roles} role="radiogroup" aria-labelledby={`wn-h-${LAST}`}>
              {ROLES.map((r, i) => {
                const sel = r.id === role;
                return (
                  <div
                    key={r.id}
                    ref={(el) => (roleRefs.current[i] = el)}
                    role="radio"
                    aria-checked={sel}
                    tabIndex={sel ? 0 : -1}
                    className={`${s.role} ${sel ? s.roleSelected : ''}`}
                    onClick={() => setRole(r.id)}
                    onKeyDown={(e) => onRoleKey(e, i)}
                  >
                    <span className={s.badge} style={{ background: r.bg }}>{r.icon}</span>
                    <span className={s.roleText}>
                      <span className={s.roleName}>{r.name}</span>
                      <span className={s.roleDesc} style={{ display: 'block' }}>{r.desc}</span>
                    </span>
                    <span className={s.radio} aria-hidden />
                  </div>
                );
              })}
            </div>
            <div className={s.roleActions}>
              <button ref={continueRef} type="button" className={s.primary} onClick={onContinue}>Continue <ArrowRight size={18} aria-hidden /></button>
              <button type="button" className={s.mutedLink} onClick={() => go(LAST - 1)}>Back</button>
            </div>
            <Footer />
          </div>
        </section>
      </main>

      {redirect && (
        <div className={s.backdrop} onClick={closeDialog}>
          <div
            className={s.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="wn-redirect-h"
            data-wn-dialog
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" className={s.close} aria-label="Close" onClick={closeDialog}><X size={20} /></button>
            <h2 id="wn-redirect-h" className={s.heading} style={{ fontSize: '1.4rem' }} aria-live="polite">Redirecting you in {count}s</h2>
            <p className={s.subtitle} style={{ margin: '0 auto' }}>Taking you to {redirect.label}.</p>
            <button ref={goNowRef} type="button" className={s.primary} onClick={() => navigate(redirect.to)}>Go now <ArrowRight size={18} aria-hidden /></button>
          </div>
        </div>
      )}
    </div>
  );
}
