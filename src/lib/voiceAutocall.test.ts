import { describe, expect, it } from 'vitest';
import { checkScript, describeSchedule, estimateRunMinutes, fillScriptText, orderedSteps, type ScriptSteps } from './voiceAutocall';

const ok: ScriptSteps = {
  start: 'a',
  steps: {
    a: { type: 'menu', say: 'Hi {first_name}, press 1', options: { '1': { next: 'b' } }, no_input: { next: 'c' } },
    b: { type: 'say', say: 'Thanks', next: 'c' },
    c: { type: 'hangup', say: 'Bye' },
  },
};

describe('voiceAutocall helpers', () => {
  it('accepts a valid script', () => {
    expect(checkScript(ok)).toEqual([]);
  });

  it('flags broken links and banned words on the step', () => {
    const bad: ScriptSteps = {
      start: 'a',
      steps: { a: { type: 'say', say: 'Repay your loan', next: 'zz' } },
    };
    const issues = checkScript(bad);
    expect(issues.some((i) => i.step === 'a' && /next/.test(i.message))).toBe(true);
    expect(issues.some((i) => /Rent Plan/.test(i.message))).toBe(true);
  });

  it('orders steps as heard', () => {
    expect(orderedSteps(ok).map(([k]) => k)).toEqual(['a', 'b', 'c']);
  });

  it('fills sample variables', () => {
    expect(fillScriptText('Hi {first_name}, {amount} due')).toBe('Hi Sarah, 50,000 due');
  });

  it('describes a daily schedule', () => {
    expect(describeSchedule({ schedule_kind: 'daily', start_at: null, window_start: '08:00', window_end: '10:00', days_of_week: [1, 2, 3, 4, 5, 6] }))
      .toBe('Every Mon–Sat, 08:00–10:00');
  });

  it('estimates run length', () => {
    expect(estimateRunMinutes(856, 5)).toBe(257);
    expect(estimateRunMinutes(856, 20)).toBe(65);
  });
});
