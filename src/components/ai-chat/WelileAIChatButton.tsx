import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { cn } from '@/lib/utils';
import WelileAIChatDrawer from './WelileAIChatDrawer';
import { isAiRole } from './roleLanding';

const GeminiSparkle = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M14 2C14 2 16.5 9 18.5 11.5C20.5 14 26 14 26 14C26 14 20.5 14 18.5 16.5C16.5 19 14 26 14 26C14 26 11.5 19 9.5 16.5C7.5 14 2 14 2 14C2 14 7.5 14 9.5 11.5C11.5 9 14 2 14 2Z"
      fill="currentColor"
    />
  </svg>
);

// Inline trigger for embedding in cards (e.g. wallet header)
export function WelileAITrigger() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <motion.button
        whileHover={{ scale: 1.15, rotate: 15 }}
        whileTap={{ scale: 0.9 }}
        onClick={() => setOpen(true)}
        className={cn(
          "h-9 w-9 rounded-full",
          "bg-gradient-to-br from-primary to-primary/80",
          "text-primary-foreground",
          "shadow-lg shadow-primary/30",
          "flex items-center justify-center",
          "transition-shadow duration-200",
          "hover:shadow-primary/50",
        )}
        aria-label="Open Welile AI"
      >
        <GeminiSparkle size={18} />
      </motion.button>
      <WelileAIChatDrawer open={open} onOpenChange={setOpen} />
    </>
  );
}

// Global floating button — static, visible everywhere
export default function WelileAIChatButton() {
  const [open, setOpen] = useState(false);

  return (
    <>

      <motion.button
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 20 }}
        whileTap={{ scale: 0.93 }}
        onClick={() => setOpen(true)}
        className={cn(
          "fixed bottom-6 right-4 z-[60] hidden md:flex",
          "h-12 md:px-3.5 rounded-full",
          "bg-gradient-to-r from-primary to-primary/85",
          "text-primary-foreground",
          "shadow-lg shadow-primary/25",
          "flex items-center gap-1.5",
          "active:shadow-primary/40",
          "transition-shadow duration-200",
          "border border-primary-foreground/15"
        )}
        aria-label="Open Welile AI"
      >
        <GeminiSparkle size={18} />
        <span className="font-semibold text-xs whitespace-nowrap">Welile AI</span>
      </motion.button>

      <WelileAIChatDrawer open={open} onOpenChange={setOpen} />
    </>
  );
}

// Standalone page trigger — opens drawer immediately when /ai is visited
export function WelileAIPage() {
  const [open, setOpen] = useState(true);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const roleParam = searchParams.get('role');
  const initialRole = isAiRole(roleParam) ? roleParam : undefined;
  const signupSource = searchParams.get('signup_source');
  const referralCode = searchParams.get('ref');

  return (
    <>
    <Helmet>
      <link rel="canonical" href="https://welileapp.com/ai" />
      <meta property="og:url" content="https://welileapp.com/ai" />
    </Helmet>
    <WelileAIChatDrawer
      open={open}
      initialRole={initialRole}
      signupSource={signupSource}
      referralCode={referralCode}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) navigate('/welcome');
      }}
    />
    </>
  );
}
