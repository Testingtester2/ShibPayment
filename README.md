# ShibPayment

Free, non-custodial **Pay with SHIB** for any shop. A merchant pastes their wallet address, sets a price, and shares a link or drops one button on their website. Buyers pay with **SHIB, BONE, LEASH or TREAT** on any of the **13 networks** where those tokens live, straight into the merchant's wallet.

- **No fees.** ShibPayment never takes a cut and never holds money. Shibarium's built-in burns are the only "fee".
- **Optional burn.** A merchant can burn a share of every payment. It happens in the same transaction, through a tiny ownerless contract, and anyone can verify it on-chain.
- **Granny-simple.** No account, no sign-up, no crypto words on the default screens.

| Checkout | Paid | Phone |
| --- | --- | --- |
| ![Checkout](docs/screenshots/checkout.png) | ![Paid](docs/screenshots/paid.png) | ![QR](docs/screenshots/mobile-qr.png) |

## What's in here

| Path | What it is |
| --- | --- |
| `packages/chains` | Chain and token registry: 13 EVM networks and 41 token deployments, copied from ShibWallet, plus the (unverified) Sunrise SHIB mint on Solana. |
| `packages/contracts` | `ShibPaySplitter.sol`, the burn splitter, compiled with solc-js; deploy script. |
| `packages/core` | The SDK: quotes, payment links, paying through any EIP-1193 wallet, on-chain verification, payment search. |
| `packages/button` | `<shib-pay>`, a framework-free web component built to one script, `shib-pay.js`. |
| `apps/web` | The website: landing page, merchant link builder (`/setup.html`) and hosted payment page (`/pay.html`). |

## For merchants

Open `/setup.html`, fill in your shop name, your receiving wallet (an address, or a `.shib` / `.eth` name), a price and an optional burn. You get:

- a **payment link** and **QR code** to share in chats or print at a stall,
- an **embed snippet** for your website.

Use your own wallet, not an exchange deposit address: exchanges often don't credit tokens sent on side networks.

![Link builder](docs/screenshots/link-builder.png)

## For websites

```html
<script src="https://YOUR-SHIBPAYMENT-SITE/shib-pay.js"></script>

<shib-pay
  to="0xYourWalletAddress"
  amount="12.50" currency="USD"
  burn="2" order="A-1017"
  label="Granny's Bakery"
  return-url="https://yourshop.com/thank-you">
</shib-pay>
```

| Attribute | Meaning |
| --- | --- |
| `to` | Merchant's receiving address (required). |
| `amount`, `currency` | Price. `currency` is a fiat code (USD, EUR, NGN, INR…) converted at checkout via CoinGecko, or a token symbol (`SHIB`) to charge an exact token amount. |
| `burn` | Percent of each payment to burn, 0 to 100 (default 0). |
| `order` | Your order reference. With a burn, it is recorded on-chain in the payment event. |
| `label` | Shop name shown to the buyer. |
| `tokens` | Comma list to limit tokens, e.g. `SHIB,BONE`. |
| `return-url` | Where to send the buyer after paying; `shibpay_tx`, `shibpay_chain` and `shibpay_order` are appended. |
| `theme="dark"` | Dark trigger button instead of the orange one. |

The element fires `shibpay:paid` with `{ txHash, chainId, token, amount, burned, payer, order, merchant }`.

**Always verify on your server** before marking an order paid. Anything the browser says can be faked:

```ts
import { publicClientFor, verifyPayment } from '@shibpay/core';

const result = await verifyPayment(publicClientFor(chainId), txHash, {
  chainId, token: 'SHIB', merchant: '0xYourWallet', amount: expectedAmount, burnBps: 200, orderId: 'A-1017',
});
if (result.ok) markPaid(); else if (result.retry) tryAgainLater(); else reject(result.reason);
```

## How a payment works

- **No burn (0%)**: one ordinary token transfer from buyer to merchant. No contract is involved. A plain transfer carries no order number, so each quote gets a unique amount (a tag in the 3rd to 6th decimals), which lets `findPayment()` match QR payments to their order.
- **With a burn**: the buyer approves the exact amount, then calls `ShibPaySplitter.pay()`, which sends the burn share to `0x000000000000000000000000000000000000dEaD` and the rest to the merchant in one transaction, and emits `Paid(orderId, payer, merchant, token, amount, burned)`. For native BONE on Shibarium, `payNative()` needs no approval.
- Before asking the wallet to sign, the SDK checks the buyer's balance, so a buyer who can't afford it never pays gas for a failed transaction.

### ShibPaySplitter

- No owner, no fee, not upgradeable, holds nothing between calls.
- Only ever pulls from `msg.sender`, so an approval to it cannot be spent by anyone else (there is a test for exactly that).
- Same address on every chain through the CREATE2 deployer: **`0xd25D81E6BF55465BAbe85eA543EB6e8bCbFaba82`** (from `npm run compile`; it changes if the contract or compiler changes).
- Compiled for the `paris` EVM (no PUSH0) so one bytecode runs on all 13 networks.
- The burn rounds down; dust goes to the merchant.

Until the splitter is deployed on a network, the checkout hides burn payments there and says so. To deploy (the key only pays gas and gets no rights):

```sh
npm run compile
PRIVATE_KEY=0x... npm run deploy -w @shibpay/contracts -- shibarium ethereum
PRIVATE_KEY=0x... npm run deploy -w @shibpay/contracts -- all
```

The contract has not had an external audit yet.

## Networks and tokens

| Network | SHIB | BONE | LEASH | TREAT |
| --- | --- | --- | --- | --- |
| Shibarium | ✓ | ✓ (native gas coin) | ✓ | ✓ |
| Ethereum | ✓ | ✓ | ✓ | ✓ |
| BNB Chain, Arbitrum One, OP Mainnet, Base, Polygon, Scroll, Linea, Celo, Gnosis, Mantle, Avalanche | ✓ | ✓ | ✓ | not deployed |

Addresses come from ShibWallet's `src/lib/tokens.ts`, which verified each against the Chainlink CCIP directory, shib.io and an on-chain `symbol()` call. Impostor tokens with the same names exist, so payments are only ever matched by address. SHIB on Solana (bridged by Sunrise) is listed in the registry but switched off until its mint is verified on-chain; the Solana Pay track is the next phase.

## Development

```sh
npm install
npm test          # compiles the contracts, then runs unit, contract and end-to-end tests
npm run typecheck
npm run build     # builds shib-pay.js and the website into apps/web/dist
npm run dev       # website on http://localhost:5173 (build the button first for /shib-pay.js)
```

The tests run an in-process EVM (ganache) posing as Shibarium, with the test token's code at the real SHIB address and the splitter at its real CREATE2 address, so the SDK is tested unmodified: approve, pay, burn, verify, and every way of misreporting a payment.

## Roadmap

1. **Now:** button, payment links, link builder, burn splitter, 13 EVM networks.
2. **Next:** deploy the splitter, WooCommerce plugin, ShibWallet opening payment links directly.
3. **Then:** Solana via Solana Pay (SHIB bridged by Sunrise), WalletConnect, more shop platforms.
4. **Later:** supply-chain provenance on Shibarium.
