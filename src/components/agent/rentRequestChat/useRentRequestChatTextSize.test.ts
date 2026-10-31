import { describe, it, expect, beforeEach } from 'vitest';
import {
  readRentRequestChatTextSize,
  rentRequestChatTextSizeStorageKey,
  writeRentRequestChatTextSize,
} from './useRentRequestChatTextSize';

describe('rent request chat text size', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to large and stores the choice per agent', () => {
    expect(readRentRequestChatTextSize('agent-1')).toBe('large');
    writeRentRequestChatTextSize('medium', 'agent-1');
    expect(localStorage.getItem(rentRequestChatTextSizeStorageKey('agent-1'))).toBe('medium');
    expect(readRentRequestChatTextSize('agent-1')).toBe('medium');
    expect(readRentRequestChatTextSize('agent-2')).toBe('large');
  });

  it('ignores a stored value that is not a size', () => {
    localStorage.setItem(rentRequestChatTextSizeStorageKey('agent-1'), 'huge');
    expect(readRentRequestChatTextSize('agent-1')).toBe('large');
  });
});
