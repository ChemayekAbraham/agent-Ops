import { describe, expect, it, vi } from 'vitest';
import { counted, createSendTimer, createUploadCounter, sendButtonLabel, type SendProgress } from '@/lib/sendProgress';

describe('send button words', () => {
  it('says what is happening', () => {
    expect(sendButtonLabel(null, 'Sending…')).toBe('Sending…');
    expect(sendButtonLabel({ phase: 'uploading', done: 3, total: 6 }, '')).toBe('Uploading photos 3/6…');
    expect(sendButtonLabel({ phase: 'saving' }, '')).toBe('Saving…');
    expect(sendButtonLabel({ phase: 'sent' }, '')).toBe('Sent ✓');
  });
});

describe('upload counter', () => {
  it('counts every planned upload, failed ones too, then says saving', async () => {
    const seen: SendProgress[] = [];
    const c = createUploadCounter((p) => seen.push(p));
    c.add(2);
    c.add(1);
    await counted(c, Promise.resolve('a'));
    await counted(c, Promise.reject(new Error('x'))).catch(() => {});
    expect(seen.at(-1)).toEqual({ phase: 'uploading', done: 2, total: 3 });
    await counted(c, Promise.resolve('c'));
    expect(seen.at(-1)).toEqual({ phase: 'saving' });
  });

  it('with nothing to upload, goes straight to saving', () => {
    const onProgress = vi.fn();
    createUploadCounter(onProgress).saving();
    expect(onProgress).toHaveBeenCalledWith({ phase: 'saving' });
  });
});

describe('send timer', () => {
  it('logs the total and each step on one line', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const t = createSendTimer('new request');
    await t.step('checks', Promise.resolve(1));
    const out = t.finish('ok');
    expect(out.steps.map((s) => s.name)).toEqual(['checks']);
    expect(info.mock.calls[0][0]).toMatch(/^\[send-timing\] new request ok \d+\.\d s · checks \d+\.\d s$/);
    info.mockRestore();
  });
});
