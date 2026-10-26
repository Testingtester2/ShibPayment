import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import {
  buildPaymentLink, burnMode, fetchPrices, formatTokenAmount, orderTag, parsePaymentLink, percentToBps, quoteAmount,
  quoteWithTag, resolveShibName, roundUp, splitBurn, toEip681, validateMerchantAddress, EVM_CHAINS, getToken,
} from '../src';

const M = '0x1111111111111111111111111111111111111111';

describe('registry', () => {
  it('has the 13 EVM chains and 41 token deployments copied from ShibWallet', () => {
    expect(EVM_CHAINS).toHaveLength(13);
    expect(EVM_CHAINS.reduce((n, c) => n + c.tokens.length, 0)).toBe(41);
    expect(getToken(1, 'TREAT')).toBeTruthy();
    expect(getToken(8453, 'TREAT')).toBeUndefined();
    expect(getToken(109, 'BONE')?.native).toBe(true);
  });
});

describe('burn mode', () => {
  it('burns in the payment only on Ethereum with the splitter live; elsewhere it is a pledge', () => {
    expect(burnMode(1, 200, true)).toBe('in-tx');
    expect(burnMode(1, 200, false)).toBe('pledge');
    expect(burnMode(109, 200, true)).toBe('pledge');
    expect(burnMode(8453, 200, false)).toBe('pledge');
    expect(burnMode(1, 0, true)).toBe('none');
  });
});

describe('amounts', () => {
  it('converts percent to basis points', () => {
    expect(percentToBps('2.5')).toBe(250);
    expect(percentToBps(0)).toBe(0);
    expect(percentToBps('100')).toBe(10_000);
    expect(() => percentToBps('101')).toThrow();
    expect(() => percentToBps('-1')).toThrow();
    expect(() => percentToBps('1.234')).toThrow();
  });

  it('splits like the contract: burn rounds down', () => {
    expect(splitBurn(1000n, 250)).toEqual({ burned: 25n, toMerchant: 975n });
    expect(splitBurn(199n, 50)).toEqual({ burned: 0n, toMerchant: 199n });
    expect(() => splitBurn(1n, 10_001)).toThrow();
  });

  it('rounds up and tags amounts', () => {
    expect(roundUp(parseEther('1.001'), 18)).toBe(parseEther('1.01'));
    expect(roundUp(parseEther('1.01'), 18)).toBe(parseEther('1.01'));
    const tag = orderTag(18, () => 0.5);
    expect(tag).toBe(5000n * 10n ** 12n);
    expect(tag).toBeLessThan(10n ** 16n); // stays below the 2nd decimal
  });

  it('formats for people', () => {
    expect(formatTokenAmount(parseEther('1234567.5'), 18)).toBe('1,234,567.5');
    expect(formatTokenAmount(parseEther('10'), 18)).toBe('10');
  });
});

describe('quotes', () => {
  it('quotes local prices in tokens, rounded up', () => {
    // $10 at $0.00001234 per SHIB = 810,372.771... -> 810,372.78
    expect(quoteAmount('10', 0.00001234, 18)).toBe(parseEther('810372.78'));
    expect(quoteAmount('1', 0.5, 18)).toBe(parseEther('2'));
    const tagged = quoteWithTag('1', 0.5, 18, () => 0);
    expect(tagged).toBe(parseEther('2') + 10n ** 12n);
  });

  it('reads CoinGecko prices', async () => {
    const fake = async (url: string) => {
      expect(url).toContain('ids=shiba-inu,leash');
      expect(url).toContain('vs_currencies=eur');
      return { ok: true, json: async () => ({ 'shiba-inu': { eur: 0.00001 }, leash: {} }) };
    };
    expect(await fetchPrices(['SHIB', 'LEASH'], 'EUR', fake)).toEqual({ SHIB: 0.00001 });
  });
});

describe('merchant address and links', () => {
  it('validates the receiving address', () => {
    expect(validateMerchantAddress(` ${M} `)).toBe(M);
    expect(() => validateMerchantAddress('0x123')).toThrow(/not a valid/);
    expect(() => validateMerchantAddress('0x0000000000000000000000000000000000000000')).toThrow(/cannot receive/);
    expect(() => validateMerchantAddress('0x000000000000000000000000000000000000dead')).toThrow(/cannot receive/);
  });

  it('round-trips a payment link', () => {
    const link = buildPaymentLink('https://pay.example/pay', {
      to: M, amount: '12.50', currency: 'usd', burnBps: 250, order: 'A-17', label: "Granny's Shop",
    });
    expect(parsePaymentLink(link)).toEqual({
      to: M, amount: '12.50', currency: 'USD', burnBps: 250, order: 'A-17', label: "Granny's Shop", returnUrl: undefined,
    });
    expect(() => parsePaymentLink('https://pay.example/pay?to=' + M + '&amount=abc')).toThrow(/amount/);
    expect(() => parsePaymentLink('https://pay.example/pay?to=' + M + '&amount=1&return=javascript:alert(1)')).toThrow(/return/);
  });

  it('builds EIP-681 transfer links', () => {
    expect(toEip681({ chainId: 1, token: 'SHIB', merchant: M, amount: 5n }))
      .toBe(`ethereum:0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE@1/transfer?address=${M}&uint256=5`);
    expect(toEip681({ chainId: 109, token: 'BONE', merchant: M, amount: 7n })).toBe(`ethereum:${M}@109?value=7`);
  });

  it('resolves .shib names through the fallbacks in order', async () => {
    const calls: string[] = [];
    const fake = async (url: string) => {
      calls.push(new URL(url).host);
      if (url.includes('shibwatch')) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ items: [{ type: 'ens_domain', address_hash: M, ens_info: { name: 'granny.shib' } }] }) };
    };
    expect(await resolveShibName('Granny.shib', fake)).toBe(M);
    expect(calls).toEqual(['shibwatch.vercel.app', 'shibariumscan.io']);
  });
});
