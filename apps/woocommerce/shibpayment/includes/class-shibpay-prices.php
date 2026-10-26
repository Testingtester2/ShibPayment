<?php
/**
 * Token prices in the shop's currency, from CoinGecko (the same feed the button
 * quotes from), and the least token amount the shop accepts for a price.
 *
 * @package ShibPayment
 */

defined( 'ABSPATH' ) || defined( 'SHIBPAY_CLI' ) || exit;

final class ShibPay_Prices {
	/**
	 * Prices drift between the buyer's quote and the server's check, and the
	 * button holds a quote for 15 minutes, so a payment may come in this far
	 * under the server's figure. Filter: shibpay_price_tolerance.
	 */
	public const TOLERANCE = 0.03;

	/** @return array<string, float> symbol => price of one token, or [] when the feed is down. */
	public static function fetch( string $currency, ?array $symbols = null ): array {
		$cur = strtolower( $currency );
		$ids = ShibPay_Registry::data()['coingeckoIds'];
		$symbols ??= array_keys( $ids );
		$json = ShibPay_Http::json(
			'https://api.coingecko.com/api/v3/simple/price?ids=' . implode( ',', array_map( fn( $s ) => $ids[ $s ], $symbols ) ) . '&vs_currencies=' . rawurlencode( $cur )
		);
		$out = array();
		foreach ( $symbols as $s ) {
			$p = $json[ $ids[ $s ] ][ $cur ] ?? null;
			if ( is_numeric( $p ) && $p > 0 ) {
				$out[ $s ] = (float) $p;
			}
		}
		return $out;
	}

	/** Least acceptable payment, in smallest units, for $fiat at $price per token. */
	public static function min_amount( string $fiat, float $price, int $decimals, ?float $tolerance = null ): string {
		$tolerance ??= function_exists( 'apply_filters' ) ? (float) apply_filters( 'shibpay_price_tolerance', self::TOLERANCE ) : self::TOLERANCE;
		$tokens     = (float) $fiat / $price * ( 1 - $tolerance );
		return ShibPay_Uint::parse_units( ShibPay_Uint::from_float( $tokens ), $decimals );
	}
}
