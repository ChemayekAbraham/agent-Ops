import { describe, it, expect } from 'vitest';
import { csvCell } from './csvExport';

describe('csvCell', () => {
  it('quotes and doubles embedded quotes', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('writes null/undefined as empty and real numbers untouched', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(-5000)).toBe('"-5000"');
    expect(csvCell(0)).toBe('"0"');
  });

  it('neutralises strings that would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
    expect(csvCell('+cmd|\' /C calc\'!A0')).toMatch(/^"'\+cmd/);
    expect(csvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(csvCell('-2+3')).toBe('"\'-2+3"');
    expect(csvCell('\t=1+1')).toMatch(/^"'\t/);
  });

  it('leaves numeric-looking strings, phones and placeholders alone', () => {
    expect(csvCell('-5,000')).toBe('"-5,000"');
    expect(csvCell('+256700000000')).toBe('"+256700000000"');
    expect(csvCell('-12.5%')).toBe('"-12.5%"');
    expect(csvCell('-5000 UGX')).toBe('"-5000 UGX"');
    expect(csvCell('(1,200)')).toBe('"(1,200)"');
    expect(csvCell('-')).toBe('"-"');
    expect(csvCell('Normal text')).toBe('"Normal text"');
  });
});
