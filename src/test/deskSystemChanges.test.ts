import { describe, expect, it } from 'vitest';

import { DESKS, feedsOf } from '@/pages/desk/deskConfig';
import { decisionTone } from '@/pages/desk/format';

const onto = DESKS.find((d) => d.id === 'ontology');
if (!onto) throw new Error('ontology desk missing from DESKS');

describe('Ontology desk: System changes', () => {
  it('adds the two summary tiles at the end', () => {
    const [changes, explained] = onto.tiles.slice(-2);
    expect(changes.label).toBe('System changes, 7 days');
    expect(changes).toMatchObject({ feed: 'onto_chg_summary', field: 'changes_7d', fmt: 'int' });
    expect(changes.sub).toMatchObject({ label: 'Not published', field: 'not_published', fmt: 'int' });

    expect(explained.label).toBe('Changes that say why');
    expect(explained).toMatchObject({ feed: 'onto_chg_summary', field: 'changes_explained_share', fmt: 'pct' });
    expect(explained.sub).toMatchObject({ label: 'Builder not recorded', field: 'builder_unknown', fmt: 'int' });
  });

  it('adds the change list as the last table with the agreed columns', () => {
    const t = onto.tables[onto.tables.length - 1];
    expect(t).toMatchObject({
      id: 'onto-changes',
      feed: 'onto_chg_list',
      rowKey: 'change_ref',
      title: 'System changes, last 7 days',
    });
    expect(t.note).toContain('Database changes are picked up automatically each night');
    expect(t.columns.map((c) => c.field)).toEqual([
      'when_eat', 'kind_label', 'title', 'built_by', 'approved_by', 'why', 'status_label', 'decision',
    ]);
    expect(t.columns.map((c) => c.label)).toEqual([
      'When (EAT)', 'Type', 'Change', 'Built by', 'Approved by', 'Why', 'Status', 'Decision',
    ]);
    expect(t.columns[7].fmt).toBe('decision');
  });

  it('loads both change feeds on the Ontology desk', () => {
    const feeds = feedsOf(onto);
    expect(feeds).toContain('onto_chg_summary');
    expect(feeds).toContain('onto_chg_list');
    // The ontology desk keeps its own feeds and never pulls the rent-request pipeline.
    expect(feeds).toContain('onto_summary');
    expect(feeds).not.toContain('pipeline');
  });

  it('keeps other desks off the change feeds', () => {
    for (const d of DESKS.filter((x) => x.id !== 'ontology')) {
      expect(feedsOf(d)).not.toContain('onto_chg_summary');
      expect(feedsOf(d)).not.toContain('onto_chg_list');
    }
  });
});

describe('decisionTone for system-change decisions', () => {
  it('treats a built-but-unpublished change as a warning and a rollback as bad', () => {
    expect(decisionTone('Built, not published')).toBe('wait');
    expect(decisionTone('Rolled back after review')).toBe('stop');
  });

  it('leaves the existing tones alone', () => {
    expect(decisionTone('Explained')).toBe('go');
    expect(decisionTone('No reason recorded')).toBe('stop');
    expect(decisionTone('Stalled')).toBe('stop');
    expect(decisionTone('Slow')).toBe('wait');
  });
});
