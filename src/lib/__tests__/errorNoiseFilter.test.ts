import { describe, it, expect } from 'vitest';
import { isIgnorableClientError } from '../errorNoiseFilter';
import { isChunkLoadError } from '../lazyWithRetry';

describe('client error noise filter', () => {
  it('ignores wallet-extension and injected-script errors', () => {
    expect(isIgnorableClientError("Cannot read properties of undefined (reading 'M_ID')")).toBe(true);
    expect(isIgnorableClientError('window.ethereum is not defined')).toBe(true);
    expect(isIgnorableClientError('Window message "chrome: call method" timed out')).toBe(true);
    expect(isIgnorableClientError('boom', 'at x (chrome-extension://abc/inject.js:1:1)')).toBe(true);
    expect(isIgnorableClientError('boom', null, 'webkit-masked-url://hidden/')).toBe(true);
    expect(isIgnorableClientError('Script error.')).toBe(true);
  });

  it('keeps real app errors', () => {
    expect(isIgnorableClientError('Script error.', 'at App (https://welileapp.com/assets/a.js:1:1)')).toBe(false);
    expect(isIgnorableClientError(new TypeError("Cannot read properties of undefined (reading 'amount')"))).toBe(false);
  });

  it('recognises stale chunk errors', () => {
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: /a.js'))).toBe(true);
    expect(isChunkLoadError(new Error('Loading CSS chunk 12 failed'))).toBe(true);
    expect(isChunkLoadError(new Error('Network down'))).toBe(false);
  });
});
