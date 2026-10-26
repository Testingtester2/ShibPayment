// WalletConnect (Reown) for phone wallets. Built as its own file,
// shib-pay-walletconnect.js, and loaded only when a buyer picks WalletConnect,
// so the main button script stays small.
import { EthereumProvider } from '@walletconnect/ethereum-provider';

type Provider = Awaited<ReturnType<typeof EthereumProvider.init>>;

export interface WalletConnectOptions {
  projectId: string;
  /** The network the buyer picked comes first. */
  chainIds: number[];
  rpcMap: Record<number, string>;
  /** Above the checkout, which sits at z-index 2147483000. */
  zIndex: number;
}

let cached: { key: string; provider: Promise<Provider> } | null = null;

/** A connected EIP-1193 provider. Shows Reown's wallet picker (QR on desktop, app list on phones). */
export async function connectWalletConnect(o: WalletConnectOptions): Promise<Provider> {
  const key = `${o.projectId}:${[...o.chainIds].sort().join(',')}`;
  if (cached?.key !== key) {
    cached = {
      key,
      provider: EthereumProvider.init({
        projectId: o.projectId,
        optionalChains: o.chainIds as [number, ...number[]],
        rpcMap: Object.fromEntries(Object.entries(o.rpcMap).map(([k, v]) => [k, v])),
        showQrModal: true,
        optionalMethods: [
          'eth_sendTransaction', 'eth_requestAccounts', 'eth_accounts', 'eth_chainId', 'wallet_switchEthereumChain',
          'wallet_addEthereumChain', 'wallet_getCapabilities', 'wallet_sendCalls', 'wallet_getCallsStatus',
        ],
        qrModalOptions: { themeMode: 'dark', themeVariables: { '--wcm-z-index': String(o.zIndex) } },
        metadata: {
          name: 'ShibPayment',
          description: 'Pay with SHIB',
          url: location.origin,
          icons: ['https://shibpayments.shibfun.app/shib-logo.png'],
        },
      }),
    };
  }
  const provider = await cached.provider;
  if (!provider.session) await provider.connect({ optionalChains: o.chainIds });
  return provider;
}
