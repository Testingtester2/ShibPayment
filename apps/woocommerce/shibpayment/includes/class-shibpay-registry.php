<?php
/**
 * Networks and tokens, generated from @shibpay/chains into data/chains.json so
 * the plugin and the SDK always match payments against the same addresses.
 *
 * @package ShibPayment
 */

defined( 'ABSPATH' ) || defined( 'SHIBPAY_CLI' ) || exit;

final class ShibPay_Registry {
	private static ?array $data = null;

	public static function data(): array {
		if ( null === self::$data ) {
			self::$data = json_decode( (string) file_get_contents( dirname( __DIR__ ) . '/data/chains.json' ), true );
		}
		return self::$data;
	}

	public static function chains(): array {
		return self::data()['chains'];
	}

	public static function chain( int $chain_id ): ?array {
		foreach ( self::chains() as $c ) {
			if ( $c['chainId'] === $chain_id ) {
				return $c;
			}
		}
		return null;
	}

	public static function token( int $chain_id, string $symbol ): ?array {
		foreach ( self::chain( $chain_id )['tokens'] ?? array() as $t ) {
			if ( $t['symbol'] === $symbol ) {
				return $t;
			}
		}
		return null;
	}

	/** @return string[] SHIB, BONE, LEASH, TREAT */
	public static function symbols(): array {
		return array_keys( self::data()['coingeckoIds'] );
	}

	public static function tx_url( int $chain_id, string $hash ): string {
		$c = self::chain( $chain_id );
		return $c ? $c['explorerUrl'] . '/tx/' . $hash : '';
	}

	/** Chain whose explorer serves $url (a pasted transaction link), or null. */
	public static function chain_for_explorer_url( string $url ): ?int {
		$host = strtolower( (string) parse_url( $url, PHP_URL_HOST ) );
		foreach ( self::chains() as $c ) {
			$explorer = strtolower( (string) parse_url( $c['explorerUrl'], PHP_URL_HOST ) );
			if ( '' !== $host && ( $host === $explorer || 'www.' . $explorer === $host ) ) {
				return $c['chainId'];
			}
		}
		return null;
	}
}
