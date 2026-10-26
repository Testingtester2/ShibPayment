import { describe, expect, it } from 'vitest';
import { groupDigits, parsePrice } from '../src/amount';

describe('parsePrice', () => {
  it('reads thousands separators', () => {
    for (const s of ['10000', '10,000', '10 000', "10'000", '10\u00a0000']) expect(parsePrice(s)).toBe('10000');
    expect(parsePrice('1,000,000')).toBe('1000000');
    expect(parsePrice('1.000.000')).toBe('1000000');
    expect(parsePrice('10,00,000')).toBe('1000000');
    expect(parsePrice('1,234.56')).toBe('1234.56');
    expect(parsePrice('1.234,56')).toBe('1234.56');
    expect(parsePrice('1 234,56')).toBe('1234.56');
    expect(parsePrice(' 330 ')).toBe('330');
  });

  it('reads decimals', () => {
    expect(parsePrice('12.50')).toBe('12.5');
    expect(parsePrice('12,50')).toBe('12.5');
    expect(parsePrice('0.5')).toBe('0.5');
    expect(parsePrice('330')).toBe('330');
  });

  it('rejects what it cannot read', () => {
    for (const s of ['', '0', '0,00', 'abc', '1,2,3', '1,00,00', '1 2', "1'2", '10 00', '1_2345', '1.234.5', '12.', '-5', '1,234,56.7.8']) expect(parsePrice(s)).toBeNull();
  });

  it('groups digits for display', () => {
    expect(groupDigits('10000')).toBe('10,000');
    expect(groupDigits('1234567.25')).toBe('1,234,567.25');
    expect(groupDigits('330')).toBe('330');
  });
});
