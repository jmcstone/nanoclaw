import { describe, it, expect } from 'vitest';

import { findEmailTargetJid } from './email-routing.js';
import { RegisteredGroup } from '../types.js';

function group(overrides: Partial<RegisteredGroup>): RegisteredGroup {
  return {
    name: 'test',
    folder: 'some_folder',
    trigger: '@Madison',
    added_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('findEmailTargetJid', () => {
  it('prefers the telegram_inbox group over isMain groups', () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:1': group({ folder: 'telegram_main', isMain: true }),
      'tg:2': group({ folder: 'telegram_inbox' }),
      'tg:3': group({ folder: 'telegram_avp', isMain: true }),
    };
    expect(findEmailTargetJid(groups)).toBe('tg:2');
  });

  it('falls back to the first isMain group when no inbox group exists', () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:1': group({ folder: 'telegram_main', isMain: true }),
      'tg:2': group({ folder: 'telegram_avp', isMain: true }),
    };
    expect(findEmailTargetJid(groups)).toBe('tg:1');
  });

  it('returns null when no inbox and no main group exists', () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:1': group({ folder: 'telegram_main' }),
    };
    expect(findEmailTargetJid(groups)).toBeNull();
  });

  it('returns null for an empty group set', () => {
    expect(findEmailTargetJid({})).toBeNull();
  });

  it('picks the inbox group even when it is not flagged isMain', () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:1': group({ folder: 'telegram_inbox', isMain: false }),
    };
    expect(findEmailTargetJid(groups)).toBe('tg:1');
  });
});
