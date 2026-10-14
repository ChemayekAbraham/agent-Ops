export const RD_CANVAS_BLOCKS = [
  { key: 'partners', title: 'Key Partners' },
  { key: 'activities', title: 'Key Activities' },
  { key: 'resources', title: 'Key Resources' },
  { key: 'value', title: 'Value Proposition' },
  { key: 'relationships', title: 'Customer Relationships' },
  { key: 'channels', title: 'Channels' },
  { key: 'segments', title: 'Customer Segments' },
  { key: 'costs', title: 'Cost Structure' },
  { key: 'revenue', title: 'Revenue Streams' },
] as const;

export interface RdReportIdea {
  title: string; owner: string; date: string; summary: string;
  canvas: Record<string, unknown>;
}

export function rdReportIdeaRows(idea: RdReportIdea): string[][] {
  return [
    ['Idea name', idea.title], ['Proposed by', idea.owner || '—'],
    ['Date', idea.date || '—'], ['Description', idea.summary || '—'],
    ...RD_CANVAS_BLOCKS.map(({ key, title }) => {
      const value = idea.canvas[key];
      return [title, typeof value === 'string' && value.trim() ? value : 'Not recorded'];
    }),
  ];
}