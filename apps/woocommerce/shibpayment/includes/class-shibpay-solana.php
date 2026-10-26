<?php
/**
 * SHIB on Solana: the PHP twin of verifySolanaPayment() in @shibpay/core.
 *
 * Every order gets its own Solana Pay reference key. The buyer's transfer
 * carries it, so the payment is tied to its order, and the shop can find the
 * payment from the reference alone, even when the buyer closed the page.
 *
 * @package ShibPayment
 */

defined( 'ABSPATH' ) || defined( 'SHIBPAY_CLI' ) || exit;

final class ShibPay_Solana {
	/** Key for the RPC client and order meta. Solana has no EVM chain id. */
	public const CHAIN = 'solana';
	private const SYSTEM_PROGRAM = '11111111111111111111111111111111';

	public function __construct( private ShibPay_Rpc $rpc ) {}

	public static function mint(): string {
		return ShibPay_Registry::data()['solana']['mint'];
	}

	/**
	 * Checks a shop's Solana wallet. Returns it trimmed, or throws with a
	 * plain-language message.
	 */
	public static function validate_wallet( string $s ): string {
		$s = trim( $s );
		if ( ! ShibPay_Base58::is_key( $s ) ) {
			throw new InvalidArgumentException( 'That is not a valid Solana address.' );
		}
		if ( self::SYSTEM_PROGRAM === $s || self::mint() === $s ) {
			throw new InvalidArgumentException( 'That address cannot receive payments.' );
		}
		return $s;
	}

	public static function is_signature( string $s ): bool {
		return (bool) preg_match( '/^[1-9A-HJ-NP-Za-km-z]{64,90}$/', $s ) && 64 === strlen( (string) ShibPay_Base58::decode( $s ) );
	}

	public static function tx_url( string $signature ): string {
		return ShibPay_Registry::data()['solana']['explorerUrl'] . '/tx/' . $signature;
	}

	/** SHIB's decimals on Solana, read from the chain (and remembered), or null when the network doesn't answer. */
	public function decimals(): ?int {
		$cached = function_exists( 'get_transient' ) ? get_transient( 'shibpay_sol_decimals' ) : false;
		if ( false !== $cached ) {
			return (int) $cached;
		}
		try {
			$r = $this->rpc->call( self::CHAIN, 'getAccountInfo', array( self::mint(), array( 'encoding' => 'jsonParsed', 'commitment' => 'confirmed' ) ) );
		} catch ( RuntimeException $e ) {
			return null;
		}
		$d = $r['value']['data']['parsed']['info']['decimals'] ?? null;
		if ( 'mint' !== ( $r['value']['data']['parsed']['type'] ?? '' ) || ! is_int( $d ) ) {
			return null;
		}
		if ( function_exists( 'set_transient' ) ) {
			set_transient( 'shibpay_sol_decimals', $d, DAY_IN_SECONDS );
		}
		return $d;
	}

	/** The first successful transaction carrying $reference, or null. */
	public function find( string $reference ): ?string {
		$sigs = $this->rpc->call( self::CHAIN, 'getSignaturesForAddress', array( $reference, array( 'limit' => 10, 'commitment' => 'confirmed' ) ) );
		foreach ( (array) $sigs as $s ) {
			if ( null === ( $s['err'] ?? null ) && ! empty( $s['signature'] ) ) {
				return $s['signature'];
			}
		}
		return null;
	}

	/**
	 * @param array $expected {
	 *     recipient: string    The shop's Solana wallet (owner, not token account).
	 *     minAmount: string    Least acceptable SHIB received, smallest units.
	 *     reference?: string   The order's Solana Pay reference.
	 *     burnBps: int
	 *     notBefore?: int      Unix time.
	 * }
	 * @return array Same shape as ShibPay_Verifier::verify().
	 */
	public function verify( string $signature, array $expected ): array {
		if ( ! self::is_signature( $signature ) ) {
			return self::fail( 'That is not a Solana transaction signature.' );
		}
		$recipient = $expected['recipient'];
		$mint      = self::mint();
		try {
			$tx = $this->get( $signature, 'finalized' );
			if ( ! $tx ) {
				return $this->get( $signature, 'confirmed' )
					? self::fail( 'Waiting for confirmations (not final yet)', true )
					: self::fail( 'Transaction not found yet', true );
			}
		} catch ( RuntimeException $e ) {
			return self::fail( 'The network did not answer. Trying again shortly.', true );
		}
		$meta = $tx['meta'] ?? null;
		if ( ! $meta ) {
			return self::fail( 'Transaction not found yet', true );
		}
		if ( null !== ( $meta['err'] ?? null ) ) {
			return self::fail( 'Transaction failed on-chain' );
		}

		$sum = function ( array $balances ) use ( $mint, $recipient ) {
			$total = '0';
			foreach ( $balances as $b ) {
				if ( ( $b['mint'] ?? '' ) === $mint && ( $b['owner'] ?? '' ) === $recipient ) {
					$total = ShibPay_Uint::add( $total, (string) $b['uiTokenAmount']['amount'] );
				}
			}
			return $total;
		};
		$received = ShibPay_Uint::sub( $sum( $meta['postTokenBalances'] ?? array() ), $sum( $meta['preTokenBalances'] ?? array() ) );
		if ( null === $received || '0' === $received ) {
			return self::fail( 'That transaction does not pay this merchant' );
		}
		if ( ShibPay_Uint::cmp( $received, $expected['minAmount'] ) < 0 ) {
			return self::fail( 'Paid less than the price' );
		}
		if ( isset( $expected['notBefore'], $tx['blockTime'] ) && $tx['blockTime'] < $expected['notBefore'] ) {
			return self::fail( 'That payment was made before this order was placed.' );
		}

		$keys  = $tx['transaction']['message']['accountKeys'] ?? array();
		$payer = '';
		$has   = false;
		foreach ( $keys as $k ) {
			if ( '' === $payer && ! empty( $k['signer'] ) ) {
				$payer = $k['pubkey'];
			}
			$has = $has || ( isset( $expected['reference'] ) && $k['pubkey'] === $expected['reference'] );
		}
		if ( isset( $expected['reference'] ) && ! $has ) {
			return array(
				'ok'     => false,
				'reason' => 'A payment to the shop, but not marked with this order\'s code. It may belong to another order.',
				'retry'  => false,
				'review' => true,
				'payer'  => $payer,
				'amount' => $received,
			);
		}
		$burn_bps = (int) $expected['burnBps'];
		return array(
			'ok'            => true,
			'payer'         => $payer,
			'amount'        => $received,
			'confirmations' => 1,
			'viaSplitter'   => false,
			// Only Ethereum burns count, so on Solana a burn is always the shop's pledge.
			'burnMode'      => $burn_bps > 0 ? 'pledge' : 'none',
			'burned'        => '0',
			'pledged'       => ShibPay_Verifier::burn_share( $received, $burn_bps ),
		);
	}

	private function get( string $signature, string $commitment ): ?array {
		return $this->rpc->call(
			self::CHAIN,
			'getTransaction',
			array(
				$signature,
				array(
					'encoding'                       => 'jsonParsed',
					'commitment'                     => $commitment,
					'maxSupportedTransactionVersion' => 0,
				),
			)
		);
	}

	private static function fail( string $reason, bool $retry = false ): array {
		return array(
			'ok'     => false,
			'reason' => $reason,
			'retry'  => $retry,
		);
	}
}
