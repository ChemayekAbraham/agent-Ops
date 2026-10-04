import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Language, translations, Translations } from '@/i18n/translations';
import { supabase } from '@/integrations/supabase/client';

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: Translations;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const STORAGE_KEY = 'welile-language';
const PHONE_LANG_SET_KEY = 'welile-phone-lang-set';

// Map phone prefixes to languages
const phonePrefixToLanguage: Record<string, Language> = {
  '+256': 'en', // Uganda → English
  '+254': 'sw', // Kenya → Swahili
  '+255': 'sw', // Tanzania → Swahili
  '+250': 'en', // Rwanda → English
  '+251': 'am', // Ethiopia → Amharic
  '+243': 'fr', // DRC → French
  '+257': 'fr', // Burundi → French
};

// Detect browser language and map to supported languages
const detectBrowserLanguage = (): Language => {
  if (typeof navigator === 'undefined') return 'en';
  
  const browserLang = navigator.language.toLowerCase();
  
  // Map browser languages to our supported languages
  if (browserLang.startsWith('sw')) return 'sw';
  if (browserLang.startsWith('fr')) return 'fr';
  if (browserLang.startsWith('am')) return 'am';
  
  return 'en';
};

export const LanguageProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(() => {
    // Check localStorage first
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && ['en', 'sw', 'fr', 'am'].includes(stored)) {
        return stored as Language;
      }
    }
    return detectBrowserLanguage();
  });

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem(STORAGE_KEY, lang);
    
    // Update HTML lang attribute for accessibility and SEO
    document.documentElement.lang = lang === 'am' ? 'am' : lang === 'sw' ? 'sw' : lang === 'fr' ? 'fr' : 'en';
  };

  // Auto-set language based on user's phone number after login
  useEffect(() => {
    const checkPhoneLanguage = async () => {
      // Only auto-set once per session
      if (localStorage.getItem(PHONE_LANG_SET_KEY)) return;

      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user?.id) return;

      const { data: profile } = await supabase
        .from('profiles')
        .select('phone')
        .eq('id', session.user.id)
        .maybeSingle();

      if (!profile?.phone) return;

      const phone = profile.phone.replace(/\s/g, '');
      // Normalize Ugandan local numbers
      const normalizedPhone = phone.startsWith('0') ? '+256' + phone.slice(1) : phone;

      for (const [prefix, lang] of Object.entries(phonePrefixToLanguage)) {
        if (normalizedPhone.startsWith(prefix)) {
          // Only set if user hasn't manually chosen
          if (!localStorage.getItem(STORAGE_KEY)) {
            setLanguage(lang);
          }
          localStorage.setItem(PHONE_LANG_SET_KEY, 'true');
          return;
        }
      }
      localStorage.setItem(PHONE_LANG_SET_KEY, 'true');
    };

    checkPhoneLanguage();
  }, []);

  useEffect(() => {
    // Set initial lang attribute
    document.documentElement.lang = language === 'am' ? 'am' : language === 'sw' ? 'sw' : language === 'fr' ? 'fr' : 'en';
  }, []);

  const value: LanguageContextType = {
    language,
    setLanguage,
    t: translations[language],
  };

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = (): LanguageContextType => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
};
