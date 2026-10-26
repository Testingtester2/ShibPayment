=== ShibPayment for WooCommerce ===
Tags: shib, shiba inu, crypto, payments, woocommerce
Requires at least: 6.3
Tested up to: 6.8
Requires PHP: 8.0
Stable tag: 0.1.0
License: MIT

Pay with SHIB at checkout. SHIB, BONE, LEASH or TREAT on 13 networks, plus SHIB on Solana, straight into your own wallet. No fees.

== Description ==

Customers pay with SHIB, BONE, LEASH or TREAT on Shibarium, Ethereum and 11 more networks. The money goes from their wallet straight to yours: ShibPayment never holds it and takes no fee.

* SHIB on Solana too, from Phantom, Solflare and other Solana wallets: add your Solana wallet in the settings.
* Prices stay in your shop's currency. The checkout converts them at the current rate.
* Orders are marked paid only after the payment is confirmed on the blockchain, checked by your own server.
* Optional burn: give a share of every sale to the SHIB burn. On Ethereum it burns in the payment itself. On other networks you're paid in full and burn your share later with the burn helper, because burns only count on Ethereum.
* Works with the classic checkout and the block checkout.

== Installation ==

1. Plugins → Add New → Upload Plugin, choose shibpayment-woocommerce.zip, Install, Activate.
2. WooCommerce → Settings → Payments → Pay with SHIB.
3. Paste your wallet address (0x…) or .shib name, and your Solana wallet if you want SHIB on Solana too. Set a burn % if you like, tick "Turn on", Save.

Use your own wallet, not an exchange deposit address: exchanges often don't credit tokens sent on side networks.

== Frequently Asked Questions ==

= What if a customer pays but the order isn't marked paid? =

Payments that need more confirmations are rechecked every 30 seconds for an hour. A payment that can't be tied to its order for sure (for example, one sent by hand without the order's code in the amount) is put on hold with a note and a link to the transaction, so you can check it and mark the order Processing yourself.

= A customer paid from their phone and closed the page. =

On Solana the shop finds the payment by itself for half an hour after checkout. Otherwise they can open the order's payment page again (from the order email or My Account) and paste the transaction link from their wallet under "Already paid?".

= Does it send data anywhere? =

The plugin asks CoinGecko for prices and public blockchain nodes for the payment. No account, no tracking.
