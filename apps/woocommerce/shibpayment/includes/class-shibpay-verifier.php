<?php
/**
 * On-chain payment check, the PHP twin of verifyPayment() in @shibpay/core.
 * Runs on the shop's server before an order is marked paid, because anything
 * the buyer's browser reports can be faked.
 *
 * On top of the SDK's checks it binds a plain transfer to its order: the button
 * puts the order's 4-digit tag in the 3rd to 6th decimals of the amount, and
 * the payment must be no older than the order.
 *
 * @package ShibPayment
 */

defined( 'ABSPATH' ) || defined( 'SHIBPAY_CLI' ) || exit;

final class ShibPay_Verifier {
	private const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

	public function __construct( private ShibPay_Rpc $rpc ) {}

	/**
	 * @param string $tx_hash  0x-prefixed transaction hash.
	 * @param array  $expected {
	 *     chainId: int, token: string, merchant: string,
	 *     minAmount: string     Least acceptable total (burn included), smallest units, decimal string.
	 *     burnBps: int          Burn the merchant asked for.
	 *     orderId?: string      A splitter payment must carry this reference.
	 *     tag?: int             1..9999. A plain transfer's amount must carry it (see orderTag in @shibpay/core).
	 *     notBefore?: int       Unix time. Payments in earlier blocks are refused.
	 *     minConfirmations?: int Default 2.
	 *     splitter?: string
	 * }
	 * @return array{ok: true, payer: string, amount: string, confirmations: int, viaSplitter: bool, burnMode: string, burned: string, pledged: string}
	 *       | array{ok: false, reason: string, retry: bool, review?: bool, payer?: string, amount?: string}
	 *         retry: try again later (not mined or confirmed yet, or the network didn't answer).
	 *         review: a real payment to the merchant that can't be tied to this order; a person should look.
	 */
	public function verify( string $tx_hash, array $expected ): array {
		$chain_id = (int) $expected['chainId'];
		$token    = ShibPay_Registry::token( $chain_id, $expected['token'] );
		if ( ! $token ) {
			return self::fail( "{$expected['token']} is not supported on chain $chain_id" );
		}
		if ( ! preg_match( '/^0x[0-9a-fA-F]{64}$/', $tx_hash ) ) {
			return self::fail( 'That is not a transaction hash.' );
		}
		$merchant = $expected['merchant'];
		$splitter = $expected['splitter'] ?? ShibPay_Registry::data()['splitter'];
		$burn_bps = (int) $expected['burnBps'];

		try {
			$receipt = $this->rpc->call( $chain_id, 'eth_getTransactionReceipt', array( $tx_hash ) );
			if ( ! $receipt ) {
				return self::fail( 'Transaction not found yet', true );
			}
			if ( '0x1' !== $receipt['status'] ) {
				return self::fail( 'Transaction failed on-chain' );
			}
			$block_number  = hexdec( $receipt['blockNumber'] );
			$confirmations = hexdec( $this->rpc->call( $chain_id, 'eth_blockNumber' ) ) - $block_number + 1;
			$need          = (int) ( $expected['minConfirmations'] ?? 2 );
			if ( $confirmations < $need ) {
				return self::fail( "Waiting for confirmations ($confirmations/$need)", true );
			}
			if ( isset( $expected['notBefore'] ) ) {
				$block = $this->rpc->call( $chain_id, 'eth_getBlockByNumber', array( $receipt['blockNumber'], false ) );
				if ( $block && hexdec( $block['timestamp'] ) < $expected['notBefore'] ) {
					return self::fail( 'That payment was made before this order was placed.' );
				}
			}

			// 1. Through the splitter: trust its Paid event (the contract reverts unless both transfers succeed).
			$token_addr = ! empty( $token['native'] ) ? ShibPay_Address::ZERO : $token['address'];
			$order_hash = isset( $expected['orderId'] ) ? ShibPay_Keccak::hash( (string) $expected['orderId'] ) : null;
			foreach ( $receipt['logs'] as $log ) {
				if ( ! ShibPay_Address::equal( $log['address'], $splitter ) || count( $log['topics'] ) !== 4
					|| strtolower( $log['topics'][0] ) !== ShibPay_Registry::data()['paidTopic'] ) {
					continue;
				}
				$words = str_split( substr( $log['data'], 2 ), 64 );
				if ( count( $words ) < 3 ) {
					continue;
				}
				if ( ! ShibPay_Address::equal( ShibPay_Address::from_topic( $log['topics'][3] ), $merchant )
					|| ! ShibPay_Address::equal( ShibPay_Address::from_topic( $words[0] ), $token_addr ) ) {
					continue;
				}
				if ( null !== $order_hash && strtolower( $log['topics'][1] ) !== $order_hash ) {
					continue;
				}
				$amount = ShibPay_Uint::from_hex( $words[1] );
				$burned = ShibPay_Uint::from_hex( $words[2] );
				if ( ShibPay_Uint::cmp( $amount, $expected['minAmount'] ) < 0 ) {
					return self::fail( 'Paid less than the price' );
				}
				if ( ShibPay_Uint::cmp( $burned, self::burn_share( $amount, $burn_bps ) ) < 0 ) {
					return self::fail( 'Burned less than the merchant asked for' );
				}
				return array(
					'ok'            => true,
					'payer'         => ShibPay_Address::from_topic( $log['topics'][2] ),
					'amount'        => $amount,
					'confirmations' => $confirmations,
					'viaSplitter'   => true,
					'burnMode'      => 'in-tx',
					'burned'        => $burned,
					'pledged'       => '0',
				);
			}

			// 2. A plain transfer. With a burn, that's the merchant's pledge, except on
			// Ethereum once the splitter is live, where the burn must be in the payment.
			if ( $burn_bps > 0 && $chain_id === ShibPay_Registry::data()['burnChainId'] && $this->splitter_live( $splitter ) ) {
				return self::fail( 'No burn payment to this merchant in that transaction' );
			}

			if ( ! empty( $token['native'] ) ) {
				$tx = $this->rpc->call( $chain_id, 'eth_getTransactionByHash', array( $tx_hash ) );
				if ( ! $tx || ! ShibPay_Address::equal( $tx['to'], $merchant ) ) {
					return self::fail( 'That transaction does not pay this merchant' );
				}
				$payer = strtolower( $tx['from'] );
				$total = ShibPay_Uint::from_hex( $tx['value'] );
			} else {
				$total = '0';
				$payer = null;
				foreach ( $receipt['logs'] as $log ) {
					if ( ! ShibPay_Address::equal( $log['address'], $token['address'] ) || count( $log['topics'] ) !== 3
						|| strtolower( $log['topics'][0] ) !== self::TRANSFER_TOPIC ) {
						continue;
					}
					if ( ShibPay_Address::equal( ShibPay_Address::from_topic( $log['topics'][2] ), $merchant ) ) {
						$total   = ShibPay_Uint::add( $total, ShibPay_Uint::from_hex( $log['data'] ) );
						$payer ??= ShibPay_Address::from_topic( $log['topics'][1] );
					}
				}
				if ( null === $payer ) {
					return self::fail( 'That transaction does not pay this merchant' );
				}
			}
			if ( ShibPay_Uint::cmp( $total, $expected['minAmount'] ) < 0 ) {
				return self::fail( 'Paid less than the price' );
			}
			if ( isset( $expected['tag'] ) && ! self::has_tag( $total, (int) $token['decimals'], (int) $expected['tag'] ) ) {
				return array(
					'ok'     => false,
					'reason' => 'A payment to the shop, but not marked with this order\'s code. It may belong to another order.',
					'retry'  => false,
					'review' => true,
					'payer'  => $payer,
					'amount' => $total,
				);
			}
			return array(
				'ok'            => true,
				'payer'         => $payer,
				'amount'        => $total,
				'confirmations' => $confirmations,
				'viaSplitter'   => false,
				'burnMode'      => $burn_bps > 0 ? 'pledge' : 'none',
				'burned'        => '0',
				'pledged'       => self::burn_share( $total, $burn_bps ),
			);
		} catch ( RuntimeException $e ) {
			return self::fail( 'The network did not answer. Trying again shortly.', true );
		}
	}

	public function splitter_live( ?string $splitter = null ): bool {
		$code = $this->rpc->call( ShibPay_Registry::data()['burnChainId'], 'eth_getCode', array( $splitter ?? ShibPay_Registry::data()['splitter'], 'latest' ) );
		return is_string( $code ) && '0x' !== $code && '' !== $code;
	}

	/** Same rounding as ShibPaySplitter: the burn rounds down. */
	public static function burn_share( string $amount, int $burn_bps ): string {
		return ShibPay_Uint::div( ShibPay_Uint::mul( $amount, $burn_bps ), 10000 );
	}

	/** Whether $amount carries $tag in its 3rd to 6th decimals, as the button's quotes do. */
	public static function has_tag( string $amount, int $decimals, int $tag ): bool {
		if ( $decimals < 6 ) {
			return true;
		}
		$low = substr( str_pad( $amount, $decimals - 2, '0', STR_PAD_LEFT ), -( $decimals - 2 ) );
		return $low === str_pad( (string) $tag, 4, '0', STR_PAD_LEFT ) . str_repeat( '0', $decimals - 6 );
	}

	private static function fail( string $reason, bool $retry = false ): array {
		return array(
			'ok'     => false,
			'reason' => $reason,
			'retry'  => $retry,
		);
	}
}
