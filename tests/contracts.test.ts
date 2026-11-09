import { describe, expect, it } from 'vitest';
import {
  conditionComparison,
  isValidDate,
  observationProblem,
  todayInZone,
} from '@rental-record/contracts';
import { readConfig } from '../apps/api/src/config.js';

describe('record meaning', () => {
  it('distinguishes an unrecorded item from an item that could not be inspected', () => {
    expect(observationProblem(null, 'Wating for keys')).not.toBeNull();
    expect(observationProblem('not_checked', 'The door was locked.')).toBeNull();
    expect(observationProblem('no_issue', '')).toBeNull();
  });

  it('does not infer unchanged damage or a repair from two condition selections', () => {
    expect(conditionComparison('issue', 'issue')).toBe('review_note');
    expect(conditionComparison('issue', 'no_issue')).toBe('changed');
    expect(conditionComparison('not_checked', 'no_issue')).toBe('unavailable');
    expect(conditionComparison(null, 'no_issue')).toBe('unrecorded');
  });
});

describe('dates', () => {
  it.each(['2025-02-29', '2025-02-30', '2025-13-01', '2025-2-01', 'invaild'])(
    'reject the invaild calendar date %s',
    (date) => {
      expect(isValidDate(date)).toBe(false);
    },
  );

  it('accepts a leap day only in a leap year', () => {
    expect(isValidDate('2024-02-29')).toBe(true);
    expect(isValidDate('2025-02-28')).toBe(true);
  });

  it('calculates today in the property time zone at a UTC date boundary', () => {
    const instant = new Date('2025-01-01T03:00:00.000Z');
    expect(todayInZone('America/New_York', instant)).toBe('2024-12-31');
    expect(todayInZone('Asia/Seoul', instant)).toBe('2025-01-01');
  });
});

describe('runtime boundaries', () => {
  it('refuses production demo mode', () => {
    expect(() => readConfig({ mode: 'demo', isProduction: true })).toThrow(/Demo mode/);
  });

  it('refuse to expose demo mode through a public bind address', () => {
    expect(() => readConfig({ mode: 'demo', isProduction: false, host: '0.0.0.0' })).toThrow(
      /loopback/,
    );
  });

  it('refuses a non-local application origin in demo mode', () => {
    expect(() =>
      readConfig({
        mode: 'demo',
        isProduction: false,
        host: '127.0.0.1',
        appUrl: 'https://example.com',
      }),
    ).toThrow(/localhost|loopback/);
  });
});
