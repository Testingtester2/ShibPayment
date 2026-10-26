<?php
/**
 * Unsigned integers of any size as decimal strings. Token amounts are 18-decimal
 * uint256 values, too big for PHP ints, and bcmath/gmp are not on every host.
 *
 * @package ShibPayment
 */

defined( 'ABSPATH' ) || defined( 'SHIBPAY_CLI' ) || exit;

final class ShibPay_Uint {
	/** "0x1bc16d674ec80000" -> "2000000000000000000". */
	public static function from_hex( string $hex ): string {
		$hex = ltrim( strtolower( preg_replace( '/^0x/i', '', $hex ) ), '0' );
		$dec = '0';
		foreach ( str_split( $hex ) as $nibble ) {
			$dec = self::add( self::mul( $dec, 16 ), (string) hexdec( $nibble ) );
		}
		return $dec;
	}

	public static function norm( string $a ): string {
		$a = ltrim( $a, '0' );
		return '' === $a ? '0' : $a;
	}

	/** -1, 0 or 1. */
	public static function cmp( string $a, string $b ): int {
		$a = self::norm( $a );
		$b = self::norm( $b );
		if ( strlen( $a ) !== strlen( $b ) ) {
			return strlen( $a ) <=> strlen( $b );
		}
		return strcmp( $a, $b ) <=> 0;
	}

	public static function add( string $a, string $b ): string {
		$a     = strrev( $a );
		$b     = strrev( $b );
		$out   = '';
		$carry = 0;
		for ( $i = 0, $n = max( strlen( $a ), strlen( $b ) ); $i < $n; $i++ ) {
			$sum   = (int) ( $a[ $i ] ?? 0 ) + (int) ( $b[ $i ] ?? 0 ) + $carry;
			$out  .= $sum % 10;
			$carry = intdiv( $sum, 10 );
		}
		if ( $carry ) {
			$out .= $carry;
		}
		return self::norm( strrev( $out ) );
	}

	/** $a * $m, for a small non-negative int $m. */
	public static function mul( string $a, int $m ): string {
		$out   = '';
		$carry = 0;
		for ( $i = strlen( $a ) - 1; $i >= 0; $i-- ) {
			$p     = (int) $a[ $i ] * $m + $carry;
			$out   = ( $p % 10 ) . $out;
			$carry = intdiv( $p, 10 );
		}
		return self::norm( ( $carry ? (string) $carry : '' ) . $out );
	}

	/** floor($a / $d), for a small positive int $d. */
	public static function div( string $a, int $d ): string {
		$out = '';
		$rem = 0;
		foreach ( str_split( $a ) as $digit ) {
			$cur  = $rem * 10 + (int) $digit;
			$out .= intdiv( $cur, $d );
			$rem  = $cur % $d;
		}
		return self::norm( $out );
	}

	/** "1452380.95" with 18 decimals -> "1452380950000000000000000". Extra decimals are cut. */
	public static function parse_units( string $amount, int $decimals ): string {
		if ( ! preg_match( '/^(\d*)(?:\.(\d*))?$/', trim( $amount ), $m ) ) {
			return '0';
		}
		$frac = substr( str_pad( $m[2] ?? '', $decimals, '0' ), 0, $decimals );
		return self::norm( $m[1] . $frac );
	}

	/** "1452380950000000000000000" -> "1,452,380.95" (up to $max_fraction decimals). */
	public static function format_units( string $amount, int $decimals, int $max_fraction = 6 ): string {
		$amount = str_pad( self::norm( $amount ), $decimals + 1, '0', STR_PAD_LEFT );
		$int    = substr( $amount, 0, -$decimals );
		$frac   = rtrim( substr( substr( $amount, -$decimals ), 0, $max_fraction ), '0' );
		$int    = preg_replace( '/\B(?=(\d{3})+(?!\d))/', ',', $int );
		return '' === $frac ? $int : "$int.$frac";
	}

	/** Decimal string of a positive float, to $places decimals, rounded down. */
	public static function from_float( float $x, int $places = 6 ): string {
		$s = sprintf( '%.' . ( $places + 2 ) . 'F', $x );
		return substr( $s, 0, strlen( $s ) - 2 );
	}
}
