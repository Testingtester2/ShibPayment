// Chain and token registry for ShibPayments.
//
// EVM token addresses are copied from ShibWallet (EternityWallet/shibwallet,
// src/lib/tokens.ts), where each one was verified against the Chainlink CCIP
// directory, the shib.io contract list and a live symbol() call. Impostor
// tokens with these exact names exist on several chains, so payments are only
// ever matched by address, never by symbol. Do not hand-edit an address
// without the same checks.

export type TokenSymbol = 'SHIB' | 'BONE' | 'LEASH' | 'TREAT';

export const TOKEN_SYMBOLS: readonly TokenSymbol[] = ['SHIB', 'BONE', 'LEASH', 'TREAT'];

export interface TokenInfo {
  symbol: TokenSymbol;
  address: `0x${string}`;
  decimals: number;
  /** The chain's own gas coin (BONE on Shibarium). Paid with value, not transfer(). */
  native?: boolean;
}

export interface EvmChain {
  key: string;
  chainId: number;
  name: string;
  rpcUrls: string[];
  explorerUrl: string;
  nativeSymbol: string;
  tokens: TokenInfo[];
}

/** CoinGecko ids, used for local-currency quotes. */
export const COINGECKO_IDS: Record<TokenSymbol, string> = {
  SHIB: 'shiba-inu',
  BONE: 'bone-shibaswap',
  LEASH: 'leash',
  TREAT: 'shiba-inu-treat',
};

export const TOKEN_NAMES: Record<TokenSymbol, string> = {
  SHIB: 'Shiba Inu',
  BONE: 'Bone ShibaSwap',
  LEASH: 'Doge Killer',
  TREAT: 'Shiba Inu Treat',
};

/** Where burned tokens go on every EVM chain. ShibWallet's burn tracker counts it on Ethereum. */
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;

/**
 * The one chain where a burn counts. Burn trackers read the dead address on
 * Ethereum, and burning a bridged copy on another chain leaves the original
 * locked in the bridge, so supply doesn't change. Payments on other chains
 * carry the shop's burn as a pledge, which the merchant burns here later.
 */
export const BURN_CHAIN_ID = 1;

/** Shibarium first: lowest fees, and every transaction feeds the burn. */
export const DEFAULT_CHAIN_ID = 109;

export const EVM_CHAINS: EvmChain[] = [
  {
    key: 'ethereum',
    chainId: 1,
    name: 'Ethereum',
    rpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://1rpc.io/eth', 'https://cloudflare-eth.com'],
    explorerUrl: 'https://etherscan.io',
    nativeSymbol: 'ETH',
    tokens: [
      { symbol: 'SHIB', address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', decimals: 18 },
      { symbol: 'BONE', address: '0x9813037ee2218799597d83D4a5B6F3b6778218d9', decimals: 18 },
      { symbol: 'LEASH', address: '0x27C70Cd1946795B66be9d954418546998b546634', decimals: 18 },
      { symbol: 'TREAT', address: '0xa02C49Da76A085e4E1EE60A6b920dDbC8db599F4', decimals: 18 },
    ],
  },
  {
    key: 'shibarium',
    chainId: 109,
    name: 'Shibarium',
    rpcUrls: ['https://rpc.shibarium.shib.io', 'https://www.shibrpc.com', 'https://shibarium.rpc.thirdweb.com'],
    explorerUrl: 'https://shibariumscan.io',
    nativeSymbol: 'BONE',
    tokens: [
      { symbol: 'BONE', address: '0x0000000000000000000000000000000000001010', decimals: 18, native: true },
      { symbol: 'SHIB', address: '0x495eea66B0f8b636D441dC6a98d8F5C3D455C4c0', decimals: 18 },
      { symbol: 'LEASH', address: '0x65218A41Fb92637254B4f8c97448d3dF343A3064', decimals: 18 },
      { symbol: 'TREAT', address: '0x506d8d2d9c715Eb34F514cc3EF48C7aBD19e2bc7', decimals: 18 },
    ],
  },
  {
    key: 'optimism',
    chainId: 10,
    name: 'OP Mainnet',
    rpcUrls: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io', 'https://1rpc.io/op'],
    explorerUrl: 'https://optimistic.etherscan.io',
    nativeSymbol: 'ETH',
    tokens: [
      { symbol: 'SHIB', address: '0x72cc27124EA2d36AC13D502C7EBdF28cEF90c31c', decimals: 18 },
      { symbol: 'BONE', address: '0x4A7961249E49642474f9161f245Fc52D59F14113', decimals: 18 },
      { symbol: 'LEASH', address: '0xDE4dd6Db8072eb6999B88B7D7E0c8C0C01637578', decimals: 18 },
    ],
  },
  {
    key: 'bnb',
    chainId: 56,
    name: 'BNB Chain',
    rpcUrls: ['https://bsc-rpc.publicnode.com', 'https://binance.llamarpc.com', 'https://1rpc.io/bnb'],
    explorerUrl: 'https://bscscan.com',
    nativeSymbol: 'BNB',
    tokens: [
      { symbol: 'SHIB', address: '0xEc59dE82FFf1959E92b91daB975e4564FC3447cC', decimals: 18 },
      { symbol: 'BONE', address: '0xF543915698bf89BD6d429adC79577d75DA2FA1fd', decimals: 18 },
      { symbol: 'LEASH', address: '0xf94A52468fF79862B8f288faF7900d34e74A1992', decimals: 18 },
    ],
  },
  {
    key: 'gnosis',
    chainId: 100,
    name: 'Gnosis',
    rpcUrls: ['https://gnosis-rpc.publicnode.com', 'https://rpc.gnosischain.com', 'https://1rpc.io/gnosis'],
    explorerUrl: 'https://gnosisscan.io',
    nativeSymbol: 'xDAI',
    tokens: [
      { symbol: 'SHIB', address: '0xAE2e513aC868D27Bf8d697d165bB2e91C1AEA0F0', decimals: 18 },
      { symbol: 'BONE', address: '0x50E23d57309C61eab3D3d1EfE5DC02A36f945027', decimals: 18 },
      { symbol: 'LEASH', address: '0xBb1ea2697b13Cc06e03D875D2d39c06AC6dd5a93', decimals: 18 },
    ],
  },
  {
    key: 'polygon',
    chainId: 137,
    name: 'Polygon',
    rpcUrls: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.llamarpc.com', 'https://1rpc.io/matic'],
    explorerUrl: 'https://polygonscan.com',
    nativeSymbol: 'POL',
    tokens: [
      { symbol: 'SHIB', address: '0x7627D9C9b045A26672D57741C896B2A48844168D', decimals: 18 },
      { symbol: 'BONE', address: '0x56357929B7d7720ac19ad55c923E85EdAC4Fc5D3', decimals: 18 },
      { symbol: 'LEASH', address: '0x6aF85BfA857bB88F2E3Ae07839182491d34ca11d', decimals: 18 },
    ],
  },
  {
    key: 'mantle',
    chainId: 5000,
    name: 'Mantle',
    rpcUrls: ['https://mantle-rpc.publicnode.com', 'https://rpc.mantle.xyz'],
    explorerUrl: 'https://mantlescan.xyz',
    nativeSymbol: 'MNT',
    tokens: [
      { symbol: 'SHIB', address: '0x4d8E5D0c79B02A37074025B4C10854df01f33a3F', decimals: 18 },
      { symbol: 'BONE', address: '0x79a7d4EF9870474F18A88524Bf2349393B0C2e03', decimals: 18 },
      { symbol: 'LEASH', address: '0x70Ed1C42D29678D2D5Bad7197A4281B095AD7fD6', decimals: 18 },
    ],
  },
  {
    key: 'base',
    chainId: 8453,
    name: 'Base',
    rpcUrls: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://1rpc.io/base'],
    explorerUrl: 'https://basescan.org',
    nativeSymbol: 'ETH',
    tokens: [
      { symbol: 'SHIB', address: '0x9Ded28d9EC69F97efd718CE768dc39D78fd014F8', decimals: 18 },
      { symbol: 'BONE', address: '0x88B81FD1753FEF7bbFf3BbC65E4Ba73a28CC9449', decimals: 18 },
      { symbol: 'LEASH', address: '0x90B0C73F19bd2EB9Bcd6b1C6c787a63ae851b336', decimals: 18 },
    ],
  },
  {
    key: 'arbitrum',
    chainId: 42161,
    name: 'Arbitrum One',
    rpcUrls: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://1rpc.io/arb'],
    explorerUrl: 'https://arbiscan.io',
    nativeSymbol: 'ETH',
    tokens: [
      { symbol: 'SHIB', address: '0xB359155378FF5E2837f12ed0bee5168123c88ACC', decimals: 18 },
      { symbol: 'BONE', address: '0x387090cDEa72d6Ab1598394d45c5B3e05616f15D', decimals: 18 },
      { symbol: 'LEASH', address: '0x1649DE9028C0a6B958118A977099d66eF0DA5a92', decimals: 18 },
    ],
  },
  {
    key: 'celo',
    chainId: 42220,
    name: 'Celo',
    rpcUrls: ['https://celo-rpc.publicnode.com', 'https://forno.celo.org'],
    explorerUrl: 'https://celoscan.io',
    nativeSymbol: 'CELO',
    tokens: [
      { symbol: 'SHIB', address: '0xf5607d767CCa3789CAe872A33E3cfb76cFbaaaA2', decimals: 18 },
      { symbol: 'BONE', address: '0xD301a90cb3C7a9253305af30D92dd2C1FD1e704E', decimals: 18 },
      { symbol: 'LEASH', address: '0x2b702DC45b540aEDA62F60cE4E5BFAED37b1D27a', decimals: 18 },
    ],
  },
  {
    key: 'avalanche',
    chainId: 43114,
    name: 'Avalanche',
    rpcUrls: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc', 'https://1rpc.io/avax/c'],
    explorerUrl: 'https://snowtrace.io',
    nativeSymbol: 'AVAX',
    tokens: [
      { symbol: 'SHIB', address: '0x2f643d728926C20269f0A04931dd7b4b6B650204', decimals: 18 },
      { symbol: 'BONE', address: '0xec0CA5d2F362A826fa8F53C89A5Ce1C17CD604fa', decimals: 18 },
      { symbol: 'LEASH', address: '0x897Ce250199d102Ea103Aaf3a6E7906cde757560', decimals: 18 },
    ],
  },
  {
    key: 'linea',
    chainId: 59144,
    name: 'Linea',
    rpcUrls: ['https://linea-rpc.publicnode.com', 'https://rpc.linea.build', 'https://1rpc.io/linea'],
    explorerUrl: 'https://lineascan.build',
    nativeSymbol: 'ETH',
    tokens: [
      { symbol: 'SHIB', address: '0xC52F506591eb89c04620D47B895d5f951efAd4b4', decimals: 18 },
      { symbol: 'BONE', address: '0xDd2D32Fea6e166fA53DEe5c1584456c0e8A889f5', decimals: 18 },
      { symbol: 'LEASH', address: '0x4e1a69B48A7aE9Fc8fD2623089c4B378f24a64A9', decimals: 18 },
    ],
  },
  {
    key: 'scroll',
    chainId: 534352,
    name: 'Scroll',
    rpcUrls: ['https://scroll-rpc.publicnode.com', 'https://rpc.scroll.io', 'https://1rpc.io/scroll'],
    explorerUrl: 'https://scrollscan.com',
    nativeSymbol: 'ETH',
    tokens: [
      { symbol: 'SHIB', address: '0x6F7408DAc37a36cD35B5c3Bc2829f60C30E83315', decimals: 18 },
      { symbol: 'BONE', address: '0x010c6F656E06f12BB3b115FCBC9ca282654795D2', decimals: 18 },
      { symbol: 'LEASH', address: '0xCEeDbfc700d17A277Ab1cA9E19A2CaF0c42ced41', decimals: 18 },
    ],
  },
];

/**
 * SHIB on Solana, bridged from Ethereum by Sunrise (Wormhole Labs), launched
 * 4 October 2026. The mint was copied from Sunrise's SHIB page on sunrise.xyz,
 * which Sunrise's docs name as the source to trust, and matches Jupiter,
 * Solscan and tokens.xyz. A mint's decimals can never change, so they are
 * pinned here (Jupiter: 4, classic Token program). The transfer uses
 * transferChecked, so the chain itself rejects it if they were ever wrong.
 * At least seven other Solana tokens use the SHIB ticker,
 * shibwifhat (F6qoef…5J1k) among them, so payments are matched by mint only.
 */
export const SOLANA_SHIB = {
  mint: 'shib5gSoVKPjwkXrxRk7SbQFzb2R9rQB3TgQWYX4RwW',
  bridge: 'Sunrise',
  decimals: 4,
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  verified: true,
} as const;

/**
 * Chainlink CCIP, the official bridge for SHIB, BONE and LEASH on these
 * chains. Their token pools burn on the way out and release the original
 * tokens on Ethereum, so a CCIP transfer to 0x...dEaD on Ethereum is a real
 * burn. Routers are from Chainlink's CCIP directory (smartcontractkit/
 * documentation, ccip/v1_2_0/mainnet/chains.json); every lane to Ethereum
 * supports all three tokens with no rate limit. Shibarium is not on CCIP.
 */
export const CCIP_ETHEREUM_SELECTOR = 5009297550715157269n;

export const CCIP_ROUTERS: Record<number, `0x${string}`> = {
  10: '0x3206695CaE29952f4b0c22a169725a865bc8Ce0f',
  56: '0x34B03Cb9086d7D758AC55af71584F81A598759FE',
  100: '0x4aAD6071085df840abD9Baf1697d5D5992bDadce',
  137: '0x849c5ED5a80F5B408Dd4969b78c2C8fdf0565Bfe',
  5000: '0x670052635a9850bb45882Cb2eCcF66bCff0F41B7',
  8453: '0x881e3A65B4d4a04dD529061dd0071cf975F58bCD',
  42161: '0x141fa059441E0ca23ce184B6A78bafD2A517DdE8',
  42220: '0xfB48f15480926A4ADf9116Dca468bDd2EE6C5F62',
  43114: '0xF4c7E640EdA248ef95972845a62bdC74237805dB',
  59144: '0x549FEB73F2348F6cD99b9fc8c69252034897f06C',
  534352: '0x9a55E8Cab6564eb7bbd7124238932963B8Af71DC',
};

/** Tokens that can be bridged to Ethereum and burned in one step. TREAT lives on Ethereum and Shibarium only. */
export const CCIP_BURN_TOKENS: readonly TokenSymbol[] = ['SHIB', 'BONE', 'LEASH'];

export function getChain(chainId: number): EvmChain | undefined {
  return EVM_CHAINS.find((c) => c.chainId === chainId);
}

export function getToken(chainId: number, symbol: TokenSymbol): TokenInfo | undefined {
  return getChain(chainId)?.tokens.find((t) => t.symbol === symbol);
}

/** Chains where `symbol` exists, Shibarium first. */
export function chainsForToken(symbol: TokenSymbol): EvmChain[] {
  return sortChains(EVM_CHAINS.filter((c) => c.tokens.some((t) => t.symbol === symbol)));
}

/** Shibarium, then Ethereum, then the rest in registry order. */
export function sortChains(chains: EvmChain[]): EvmChain[] {
  const rank = (c: EvmChain) => (c.chainId === DEFAULT_CHAIN_ID ? 0 : c.chainId === 1 ? 1 : 2);
  return [...chains].sort((a, b) => rank(a) - rank(b));
}

export function explorerTxUrl(chainId: number, hash: string): string {
  const chain = getChain(chainId);
  return chain ? `${chain.explorerUrl}/tx/${hash}` : '';
}
