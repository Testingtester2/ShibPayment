<?php
/**
 * Ties payments to WooCommerce orders: checks a submitted transaction on-chain,
 * then marks the order paid, waits for confirmations, or asks the shop to look.
 *
 * @package ShibPayment
 */

defined( 'ABSPATH' ) || exit;

final class ShibPay_Orders {
	/** Rechecks a waiting payment every 30 seconds for about an hour. */
	private const RECHECK_EVERY = 30;
	private const MAX_ATTEMPTS  = 120;

	/** The order reference given to the button, and recorded on-chain by burn payments. */
	public static function reference( WC_Order $order ): string {
		return (string) $order->get_order_number();
	}

	public static function gateway(): ?WC_Gateway_ShibPay {
		$gateways = WC()->payment_gateways()->payment_gateways();
		return ( $gateways['shibpay'] ?? null ) instanceof WC_Gateway_ShibPay ? $gateways['shibpay'] : null;
	}

	/** Gives an order its tag and settings the first time it is sent to pay. */
	public static function prepare( WC_Order $order, WC_Gateway_ShibPay $gateway ): void {
		if ( ! $order->get_meta( '_shibpay_tag' ) ) {
			$order->update_meta_data( '_shibpay_tag', random_int( 1, 9999 ) );
		}
		$order->update_meta_data( '_shibpay_merchant', $gateway->merchant_address() );
		$order->update_meta_data( '_shibpay_burn_bps', $gateway->burn_bps() );
		$order->update_meta_data( '_shibpay_tokens', implode( ',', $gateway->tokens() ) );
		// SHIB on Solana goes to the shop's Solana wallet, found by this order's own reference key.
		$sol = in_array( 'SHIB', $gateway->tokens(), true ) ? $gateway->sol_wallet() : '';
		$order->update_meta_data( '_shibpay_sol', $sol );
		if ( $sol && ! $order->get_meta( '_shibpay_reference' ) ) {
			$order->update_meta_data( '_shibpay_reference', ShibPay_Base58::random_key() );
		}
		$order->save();
	}

	/** Keeps a server-side quote close to the one the buyer's button shows. */
	public static function refresh_quote( WC_Order $order ): void {
		$quote = json_decode( (string) $order->get_meta( '_shibpay_quote' ), true );
		if ( is_array( $quote ) && time() - ( $quote['at'] ?? 0 ) < 10 * MINUTE_IN_SECONDS && ! empty( $quote['prices'] ) ) {
			return;
		}
		$prices = self::live_prices( $order->get_currency() );
		if ( $prices ) {
			$order->update_meta_data( '_shibpay_quote', wp_json_encode( array( 'at' => time(), 'prices' => $prices ) ) );
			$order->save();
		}
	}

	private static function live_prices( string $currency ): array {
		$key    = 'shibpay_prices_' . strtolower( $currency );
		$cached = get_transient( $key );
		if ( is_array( $cached ) ) {
			return $cached;
		}
		$prices = ShibPay_Prices::fetch( $currency );
		if ( $prices ) {
			set_transient( $key, $prices, MINUTE_IN_SECONDS );
		}
		return $prices;
	}

	/**
	 * Checks $tx against $order and acts on the answer.
	 *
	 * @param string   $tx    Transaction hash, or an explorer link to it.
	 * @param int|string|null $chain Network (an EVM chain id or "solana"), when known (the button knows; a pasted hash doesn't).
	 * @param string|null $token Token, when known.
	 * @return array{status: string, message: string} status: paid | confirming | review | failed
	 */
	public static function confirm( WC_Order $order, string $tx, int|string|null $chain = null, ?string $token = null ): array {
		$tx_in = trim( $tx );
		if ( preg_match( '/0x[0-9a-fA-F]{64}/', $tx_in, $m ) ) {
			$tx    = strtolower( $m[0] );
			$chain = is_numeric( $chain ) && (int) $chain > 0 ? (int) $chain : ShibPay_Registry::chain_for_explorer_url( $tx_in );
		} elseif ( preg_match( '/[1-9A-HJ-NP-Za-km-z]{64,90}/', $tx_in, $m ) && ShibPay_Solana::is_signature( $m[0] ) ) {
			$tx    = $m[0];
			$chain = ShibPay_Solana::CHAIN;
		} else {
			return self::answer( 'failed', __( 'That doesn\'t look like a transaction. Paste the link your wallet shows after paying.', 'shibpayment' ) );
		}

		if ( ! $order->needs_payment() || 'review' === $order->get_meta( '_shibpay_state' ) ) {
			return self::status( $order );
		}
		$lock = 'shibpay_lock_' . $order->get_id();
		if ( ! add_option( $lock, time(), '', false ) ) {
			if ( time() - (int) get_option( $lock ) < 60 ) {
				return self::answer( 'confirming', __( 'Checking your payment…', 'shibpayment' ) );
			}
			update_option( $lock, time(), false );
		}
		try {
			if ( self::used_elsewhere( $order, $tx ) ) {
				return self::answer( 'failed', __( 'That payment has already been used for another order.', 'shibpayment' ) );
			}
			return ShibPay_Solana::CHAIN === $chain ? self::check_solana( $order, $tx ) : self::check( $order, $tx, $chain, $token );
		} finally {
			delete_option( $lock );
		}
	}

	/** Cron: looks at a waiting payment again. */
	public static function recheck( int $order_id ): void {
		$order = wc_get_order( $order_id );
		$tx    = $order ? (string) $order->get_meta( '_shibpay_tx' ) : '';
		if ( ! $order || '' === $tx || ! $order->needs_payment() || 'paid' === $order->get_meta( '_shibpay_state' ) ) {
			return;
		}
		self::confirm( $order, $tx, $order->get_meta( '_shibpay_chain' ) ?: null, $order->get_meta( '_shibpay_token' ) ?: null );
	}

	/** Cron: looks for a Solana payment carrying the order's reference, for buyers who paid by QR and left. */
	public static function watch_solana( int $order_id ): void {
		$order = wc_get_order( $order_id );
		if ( ! $order || ! $order->needs_payment() || $order->get_meta( '_shibpay_tx' ) || ! $order->get_meta( '_shibpay_reference' ) ) {
			return;
		}
		try {
			$sig = ( new ShibPay_Solana( new ShibPay_Rpc() ) )->find( (string) $order->get_meta( '_shibpay_reference' ) );
		} catch ( RuntimeException $e ) {
			$sig = null;
		}
		if ( $sig ) {
			self::confirm( $order, $sig, ShibPay_Solana::CHAIN );
		} elseif ( time() < (int) $order->get_meta( '_shibpay_watch_until' ) ) {
			wp_schedule_single_event( time() + MINUTE_IN_SECONDS, 'shibpay_watch_solana', array( $order_id ) );
		}
	}

	/** Watches for a Solana payment for the next half hour (the button holds a quote for 15 minutes). */
	public static function watch_solana_soon( WC_Order $order ): void {
		if ( ! $order->get_meta( '_shibpay_reference' ) ) {
			return;
		}
		$order->update_meta_data( '_shibpay_watch_until', time() + 30 * MINUTE_IN_SECONDS );
		$order->save();
		if ( ! wp_next_scheduled( 'shibpay_watch_solana', array( $order->get_id() ) ) ) {
			wp_schedule_single_event( time() + MINUTE_IN_SECONDS, 'shibpay_watch_solana', array( $order->get_id() ) );
		}
	}

	/** What to tell the buyer about the order now. */
	public static function status( WC_Order $order ): array {
		if ( $order->is_paid() ) {
			return self::answer( 'paid', __( 'Paid. Thank you!', 'shibpayment' ) );
		}
		switch ( $order->get_meta( '_shibpay_state' ) ) {
			case 'confirming':
				return self::answer( 'confirming', __( 'We can see your payment. Waiting for the network to confirm it, which usually takes under a minute.', 'shibpayment' ) );
			case 'review':
				return self::answer( 'review', __( 'Thanks! The shop will check your payment and confirm your order.', 'shibpayment' ) );
		}
		// Not ours to take payment for any more (the shop changed it by hand, or cancelled it).
		if ( ! $order->needs_payment() ) {
			return self::answer( 'closed', __( 'This order no longer needs paying.', 'shibpayment' ) );
		}
		return self::answer( 'unpaid', '' );
	}

	private static function answer( string $status, string $message ): array {
		return array(
			'status'  => $status,
			'message' => $message,
		);
	}

	private static function used_elsewhere( WC_Order $order, string $tx ): bool {
		return (bool) wc_get_orders(
			array(
				'limit'      => 1,
				'exclude'    => array( $order->get_id() ),
				'return'     => 'ids',
				'meta_query' => array( // phpcs:ignore WordPress.DB.SlowDBQuery
					array(
						'key'   => '_shibpay_tx',
						'value' => $tx,
					),
				),
			)
		);
	}

	private static function check_solana( WC_Order $order, string $sig ): array {
		$wallet = (string) $order->get_meta( '_shibpay_sol' );
		$base   = array(
			'chainId' => ShibPay_Solana::CHAIN,
			'token'   => 'SHIB',
		);
		if ( '' === $wallet ) {
			return self::retry_or_fail( $order, $sig, $base + array( 'ok' => false, 'retry' => false, 'reason' => 'This shop does not take payments on Solana' ) );
		}
		$solana   = new ShibPay_Solana( new ShibPay_Rpc() );
		$decimals = $solana->decimals();
		$total    = wc_format_decimal( $order->get_total(), wc_get_price_decimals() );
		$min      = null;
		if ( null !== $decimals ) {
			if ( 'SHIB' === strtoupper( $order->get_currency() ) ) {
				$min = ShibPay_Uint::parse_units( $total, $decimals );
			} else {
				$quote  = json_decode( (string) $order->get_meta( '_shibpay_quote' ), true );
				$prices = array_filter( array( $quote['prices']['SHIB'] ?? null, self::live_prices( $order->get_currency() )['SHIB'] ?? null ) );
				$min    = $prices ? ShibPay_Prices::min_amount( $total, max( $prices ), $decimals ) : null;
			}
		}
		if ( null === $min ) {
			return self::retry_or_fail( $order, $sig, $base + array( 'ok' => false, 'retry' => true, 'reason' => 'No price or network answer right now to check the amount' ) );
		}
		$created = $order->get_date_created();
		$r       = $base + array( 'decimals' => $decimals ) + $solana->verify(
			$sig,
			array(
				'recipient' => $wallet,
				'minAmount' => $min,
				'reference' => (string) $order->get_meta( '_shibpay_reference' ) ?: null,
				'burnBps'   => (int) $order->get_meta( '_shibpay_burn_bps' ),
				'notBefore' => $created ? $created->getTimestamp() - 10 * MINUTE_IN_SECONDS : null,
			)
		);
		if ( $r['ok'] ) {
			return self::paid( $order, $sig, $r );
		}
		return ! empty( $r['review'] ) ? self::review( $order, $sig, $r ) : self::retry_or_fail( $order, $sig, $r );
	}

	private static function check( WC_Order $order, string $tx, ?int $chain, ?string $token ): array {
		$rpc      = new ShibPay_Rpc();
		$verifier = new ShibPay_Verifier( $rpc );
		$allowed  = array_filter( explode( ',', (string) $order->get_meta( '_shibpay_tokens' ) ) ) ?: ShibPay_Registry::symbols();
		$chains   = $chain ? array( $chain ) : array_column( ShibPay_Registry::chains(), 'chainId' );
		$priced   = in_array( strtoupper( $order->get_currency() ), ShibPay_Registry::symbols(), true );
		if ( $priced ) {
			$allowed = array( strtoupper( $order->get_currency() ) );
		}

		$best = null;
		$seen = null;
		foreach ( $chains as $chain_id ) {
			if ( ! $chain ) {
				// A bare hash: find the network it lives on first.
				try {
					if ( ! $rpc->call( $chain_id, 'eth_getTransactionReceipt', array( $tx ) ) ) {
						continue;
					}
				} catch ( RuntimeException $e ) {
					continue;
				}
			}
			foreach ( $allowed as $sym ) {
				if ( ( $token && $sym !== $token ) || ! ShibPay_Registry::token( $chain_id, $sym ) ) {
					continue;
				}
				$expected = self::expected( $order, $chain_id, $sym );
				$r        = $verifier->verify( $tx, $expected ?? self::expected( $order, $chain_id, $sym, '0' ) );
				if ( null === $expected && ( $r['ok'] || ! empty( $r['review'] ) ) ) {
					// A payment in this token, but no price to check the amount against yet.
					$r = array(
						'ok'     => false,
						'retry'  => true,
						'reason' => 'No price feed right now to check the amount',
					);
				}
				$r['chainId'] = $chain_id;
				$r['token']   = $sym;
				if ( $r['ok'] ) {
					return self::paid( $order, $tx, $r );
				}
				$rank = ! empty( $r['review'] ) ? 3 : ( $r['retry'] ? 2 : ( str_contains( $r['reason'], 'does not pay' ) ? 0 : 1 ) );
				if ( null === $best || $rank > $best[0] ) {
					$best = array( $rank, $r );
				}
			}
			$seen = $chain_id;
		}

		if ( null === $best ) {
			$found = null !== $seen;
			return self::retry_or_fail(
				$order,
				$tx,
				array(
					'ok'      => false,
					'retry'   => ! $found && (bool) $chain,
					'reason'  => $found ? 'That transaction does not pay this shop in an accepted token' : 'Transaction not found yet',
					'chainId' => $chain,
					'token'   => $token,
				)
			);
		}
		$r = $best[1];
		if ( ! empty( $r['review'] ) ) {
			return self::review( $order, $tx, $r );
		}
		return self::retry_or_fail( $order, $tx, $r );
	}

	/** What the payment must look like on $chain_id in $sym, or null when there's no price to check against ($min overrides the price). */
	private static function expected( WC_Order $order, int $chain_id, string $sym, ?string $min = null ): ?array {
		$t     = ShibPay_Registry::token( $chain_id, $sym );
		$total = wc_format_decimal( $order->get_total(), wc_get_price_decimals() );
		if ( null !== $min ) {
			// Caller's own minimum.
		} elseif ( strtoupper( $order->get_currency() ) === $sym ) {
			$min = ShibPay_Uint::parse_units( $total, $t['decimals'] );
		} else {
			$quote  = json_decode( (string) $order->get_meta( '_shibpay_quote' ), true );
			$prices = array_filter( array( $quote['prices'][ $sym ] ?? null, self::live_prices( $order->get_currency() )[ $sym ] ?? null ) );
			if ( ! $prices ) {
				return null;
			}
			// The higher price asks for fewer tokens: accept a payment quoted at either.
			$min = ShibPay_Prices::min_amount( $total, max( $prices ), $t['decimals'] );
		}
		$created = $order->get_date_created();
		return array(
			'chainId'          => $chain_id,
			'token'            => $sym,
			'merchant'         => (string) $order->get_meta( '_shibpay_merchant' ),
			'minAmount'        => $min,
			'burnBps'          => (int) $order->get_meta( '_shibpay_burn_bps' ),
			'orderId'          => self::reference( $order ),
			'tag'              => (int) $order->get_meta( '_shibpay_tag' ) ?: null,
			// Allow for a server clock a little off from the chain's.
			'notBefore'        => $created ? $created->getTimestamp() - 10 * MINUTE_IN_SECONDS : null,
			'minConfirmations' => (int) apply_filters( 'shibpay_min_confirmations', 2, $chain_id ),
		);
	}

	private static function amount_text( string $amount, string $sym, int $decimals = 18 ): string {
		return ShibPay_Uint::format_units( $amount, $decimals ) . ' ' . $sym;
	}

	public static function chain_name( int|string $chain_id ): string {
		return ShibPay_Solana::CHAIN === $chain_id ? 'Solana' : ( ShibPay_Registry::chain( (int) $chain_id )['name'] ?? '' );
	}

	public static function tx_url( int|string $chain_id, string $tx ): string {
		return ShibPay_Solana::CHAIN === $chain_id ? ShibPay_Solana::tx_url( $tx ) : ShibPay_Registry::tx_url( (int) $chain_id, $tx );
	}

	private static function tx_link( int|string $chain_id, string $tx ): string {
		return sprintf( '<a href="%s" target="_blank" rel="noopener">%s</a>', esc_url( self::tx_url( $chain_id, $tx ) ), esc_html( self::chain_name( $chain_id ) . ' ' . substr( $tx, 0, 10 ) . '…' ) );
	}

	private static function remember( WC_Order $order, string $tx, array $r, string $state ): void {
		$order->update_meta_data( '_shibpay_tx', $tx );
		$order->update_meta_data( '_shibpay_chain', $r['chainId'] );
		$order->update_meta_data( '_shibpay_token', $r['token'] );
		$order->update_meta_data( '_shibpay_state', $state );
	}

	private static function paid( WC_Order $order, string $tx, array $r ): array {
		self::remember( $order, $tx, $r, 'paid' );
		$order->update_meta_data( '_shibpay_amount', $r['amount'] );
		$order->update_meta_data( '_shibpay_payer', $r['payer'] );
		$order->update_meta_data( '_shibpay_burned', $r['burned'] );
		$order->update_meta_data( '_shibpay_pledged', $r['pledged'] );
		$dec = (int) ( $r['decimals'] ?? 18 );
		/* translators: 1: amount and token, 2: network, 3: transaction link */
		$note = sprintf( __( 'Paid %1$s on %2$s. Transaction: %3$s', 'shibpayment' ), self::amount_text( $r['amount'], $r['token'], $dec ), self::chain_name( $r['chainId'] ), self::tx_link( $r['chainId'], $tx ) );
		if ( 'in-tx' === $r['burnMode'] ) {
			/* translators: %s: amount and token */
			$note .= '<br>' . sprintf( __( '%s burned in the same payment.', 'shibpayment' ), self::amount_text( $r['burned'], $r['token'] ) );
		} elseif ( 'pledge' === $r['burnMode'] && '0' !== $r['pledged'] ) {
			/* translators: %s: amount and token */
			$note .= '<br>' . sprintf( __( 'Your burn pledge for this sale: %s. Burn it on Ethereum with the burn helper (see the ShibPayment settings).', 'shibpayment' ), self::amount_text( $r['pledged'], $r['token'], $dec ) );
			// Kept in Ethereum's 18 decimals, where the burn happens.
			self::add_pledge( $r['token'], ShibPay_Uint::norm( $r['pledged'] . str_repeat( '0', max( 0, 18 - $dec ) ) ) );
		}
		$order->add_order_note( $note );
		$order->payment_complete( $tx );
		wp_clear_scheduled_hook( 'shibpay_recheck', array( $order->get_id() ) );
		wp_clear_scheduled_hook( 'shibpay_watch_solana', array( $order->get_id() ) );
		return self::status( $order );
	}

	private static function review( WC_Order $order, string $tx, array $r ): array {
		$first = 'review' !== $order->get_meta( '_shibpay_state' );
		self::remember( $order, $tx, $r, 'review' );
		$order->save();
		if ( $first ) {
			$order->update_status(
				'on-hold',
				sprintf(
					/* translators: 1: amount and token, 2: transaction link */
					__( 'The customer sent a payment of %1$s (%2$s), but it isn\'t marked with this order\'s code, so it could belong to another order. If it\'s right, change the order to Processing.', 'shibpayment' ),
					self::amount_text( $r['amount'], $r['token'], (int) ( $r['decimals'] ?? 18 ) ),
					self::tx_link( $r['chainId'], $tx )
				)
			);
		}
		wp_clear_scheduled_hook( 'shibpay_recheck', array( $order->get_id() ) );
		return self::status( $order );
	}

	private static function retry_or_fail( WC_Order $order, string $tx, array $r ): array {
		if ( ! $r['retry'] ) {
			// Only a pending tx the buyer just replaced is forgotten; a definite "no" leaves the order unpaid.
			if ( $order->get_meta( '_shibpay_tx' ) === $tx ) {
				foreach ( array( '_shibpay_tx', '_shibpay_chain', '_shibpay_token', '_shibpay_state', '_shibpay_attempts' ) as $k ) {
					$order->delete_meta_data( $k );
				}
			}
			$order->add_order_note( sprintf( 'ShibPayment: %s (%s).', esc_html( $r['reason'] ), $r['chainId'] ? self::tx_link( $r['chainId'], $tx ) : esc_html( $tx ) ) );
			$order->save();
			return self::answer( 'failed', self::buyer_reason( $r['reason'] ) );
		}

		$attempts = (int) $order->get_meta( '_shibpay_attempts' ) + 1;
		$same     = $order->get_meta( '_shibpay_tx' ) === $tx;
		self::remember( $order, $tx, $r, 'confirming' );
		$order->update_meta_data( '_shibpay_attempts', $same ? $attempts : 1 );
		$order->save();
		if ( $same && $attempts > self::MAX_ATTEMPTS ) {
			$order->update_meta_data( '_shibpay_state', 'review' );
			$order->update_status( 'on-hold', sprintf( __( 'ShibPayment could not confirm this payment within an hour (%s). Please check it yourself.', 'shibpayment' ), esc_html( $r['reason'] ) ) );
			return self::answer( 'review', __( 'Thanks! The shop will check your payment and confirm your order.', 'shibpayment' ) );
		}
		if ( ! $same && $r['chainId'] && str_starts_with( $r['reason'], 'Waiting for confirmations' ) ) {
			$order->add_order_note( sprintf( __( 'Payment seen on %s, waiting for confirmations.', 'shibpayment' ), self::tx_link( $r['chainId'], $tx ) ) );
		}
		if ( ! wp_next_scheduled( 'shibpay_recheck', array( $order->get_id() ) ) ) {
			wp_schedule_single_event( time() + self::RECHECK_EVERY, 'shibpay_recheck', array( $order->get_id() ) );
		}
		return self::status( $order );
	}

	private static function buyer_reason( string $reason ): string {
		$map = array(
			'Paid less than the price'                   => __( 'That payment is less than the order total.', 'shibpayment' ),
			'That transaction does not pay this merchant' => __( 'That transaction doesn\'t pay this shop.', 'shibpayment' ),
			'Transaction failed on-chain'                => __( 'That transaction failed on the network, so nothing was paid.', 'shibpayment' ),
			'Transaction not found yet'                  => __( 'We couldn\'t find that transaction yet. If you just paid, wait a minute and try again.', 'shibpayment' ),
		);
		return $map[ $reason ] ?? $reason;
	}

	/** Running total of burns the shop has pledged and not yet marked as done. */
	public static function pledged(): array {
		$p = get_option( 'shibpay_pledged', array() );
		return is_array( $p ) ? $p : array();
	}

	private static function add_pledge( string $sym, string $amount ): void {
		$p         = self::pledged();
		$p[ $sym ] = ShibPay_Uint::add( $p[ $sym ] ?? '0', $amount );
		update_option( 'shibpay_pledged', $p, false );
	}
}
