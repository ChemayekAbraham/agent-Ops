export interface PlannedMarket {
  country: string;
  flag: string;
  status: 'Scouting' | 'Onboarding partners' | 'Pilot' | 'Launching soon';
  eta: string;
  notes?: string;
}

export const PLANNED_MARKETS: PlannedMarket[] = [
  { country: 'Kenya',        flag: '🇰🇪', status: 'Onboarding partners', eta: 'Q3 2026', notes: 'Nairobi & Mombasa first' },
  { country: 'Nigeria',      flag: '🇳🇬', status: 'Scouting',            eta: 'Q4 2026', notes: 'Lagos pilot planned' },
  { country: 'South Africa', flag: '🇿🇦', status: 'Launching soon',      eta: 'Q2 2026', notes: 'Johannesburg & Cape Town' },
];