// WalletConnect (Reown) for pages outside the checkout button, such as the burn helper.
import { getChain, type Eip1193Provider } from '@shibpay/core';

// Reown (WalletConnect) project for shibpayments.shibfun.app; it only works on domains allowed in its dashboard.
export const WALLETCONNECT_PROJECT_ID = 'baa20aa26d36f8ba686135b5fac6bca8';
export const WALLETCONNECT_SCRIPT = '/shib-pay-walletconnect.js';

type WalletConnectModule = typeof import('../../../packages/button/src/walletconnect');

/** Shows Reown's wallet picker and returns the connected wallet. The first chain is where it starts. */
export async function connectWithWalletConnect(chainIds: number[]): Promise<Eip1193Provider> {
  const wc = (await import(/* @vite-ignore */ WALLETCONNECT_SCRIPT)) as WalletConnectModule;
  return wc.connectWalletConnect({
    projectId: WALLETCONNECT_PROJECT_ID,
    chainIds,
    rpcMap: Object.fromEntries(chainIds.map((id) => [id, getChain(id)!.rpcUrls[0]])),
    zIndex: 2147483600,
  }) as unknown as Eip1193Provider;
}

/** True when the wallet picker was closed, which is not an error to show. */
export function pickerClosed(err: unknown): boolean {
  const text = String((err as Error)?.message ?? err).toLowerCase();
  return text.includes('closed') || text.includes('reset');
}

/** Links that reopen this page inside a wallet app's own browser. */
export function walletAppLinks(): string {
  const here = location.href;
  const metamask = `https://metamask.app.link/dapp/${location.host}${location.pathname}${location.search}`;
  const trust = `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(here)}`;
  return `<div class="note">No wallet in this browser. Connect one with WalletConnect, or open this page in your wallet app:
    <a href="${metamask}">MetaMask</a> · <a href="${trust}">Trust Wallet</a> · or copy the address into ShibWallet's browser.</div>`;
}
