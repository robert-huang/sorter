import { describe, expect, it } from 'vitest';
import { formatDateTimeLocal, parseDateTimeText, toDateTimeLocal } from '../dateTimeText';

describe('parseDateTimeText', () => {
  it('treats a date alone as midnight', () => {
    expect(parseDateTimeText('2026-01-05')).toBe('2026-01-05T00:00');
    expect(parseDateTimeText(' 2026/1/5 ')).toBe('2026-01-05T00:00');
  });

  it('accepts a time, dropping any seconds', () => {
    expect(parseDateTimeText('2026-01-05 14:30')).toBe('2026-01-05T14:30');
    expect(parseDateTimeText('2026-01-05T14:30:15')).toBe('2026-01-05T14:30');
  });

  it('accepts compact YYYYMMDD with an optional time', () => {
    expect(parseDateTimeText('20261030')).toBe('2026-10-30T00:00');
    expect(parseDateTimeText('20261030 1430')).toBe('2026-10-30T14:30');
    expect(parseDateTimeText('20261030T14:30')).toBe('2026-10-30T14:30');
  });

  it('rejects text that is not a real date/time', () => {
    for (const text of [
      '',
      'soon',
      '2026-02-30',
      '2026-01-05 25:00',
      '2026-13-01',
      '05/01/2026',
      '20260230',
      '2026103',
    ]) {
      expect(parseDateTimeText(text)).toBeNull();
    }
  });
});

describe('toDateTimeLocal / formatDateTimeLocal', () => {
  it('keeps minute precision and formats with a space', () => {
    expect(toDateTimeLocal(new Date(2026, 0, 5, 9, 7, 3))).toBe('2026-01-05T09:07');
    expect(formatDateTimeLocal('2026-01-05T09:07:03')).toBe('2026-01-05 09:07');
  });
});
