<?php
/**
 * Base58 (Bitcoin alphabet), as Solana writes addresses and signatures.
 *
 * @package ShibPayment
 */

defined( 'ABSPATH' ) || defined( 'SHIBPAY_CLI' ) || exit;

final class ShibPay_Base58 {
	private const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

	public static function encode( string $bytes ): string {
		$digits = array();
		foreach ( unpack( 'C*', $bytes ) ?: array() as $byte ) {
			$carry = $byte;
			foreach ( $digits as $i => $d ) {
				$carry       += $d << 8;
				$digits[ $i ] = $carry % 58;
				$carry        = intdiv( $carry, 58 );
			}
			while ( $carry > 0 ) {
				$digits[] = $carry % 58;
				$carry    = intdiv( $carry, 58 );
			}
		}
		$out = '';
		for ( $i = 0; $i < strlen( $bytes ) && "\0" === $bytes[ $i ]; $i++ ) {
			$out .= '1';
		}
		foreach ( array_reverse( $digits ) as $d ) {
			$out .= self::ALPHABET[ $d ];
		}
		return $out;
	}

	/** Raw bytes, or null when $s isn't base58. */
	public static function decode( string $s ): ?string {
		$bytes = array();
		foreach ( str_split( $s ) as $c ) {
			$carry = strpos( self::ALPHABET, $c );
			if ( false === $carry || '' === $s ) {
				return null;
			}
			foreach ( $bytes as $i => $b ) {
				$carry      += $b * 58;
				$bytes[ $i ] = $carry & 0xff;
				$carry     >>= 8;
			}
			while ( $carry > 0 ) {
				$bytes[] = $carry & 0xff;
				$carry >>= 8;
			}
		}
		$lead = strspn( $s, '1' );
		return str_repeat( "\0", $lead ) . ( $bytes ? pack( 'C*', ...array_reverse( $bytes ) ) : '' );
	}

	/** A Solana address: base58 of 32 bytes. */
	public static function is_key( string $s ): bool {
		$s = trim( $s );
		return (bool) preg_match( '/^[1-9A-HJ-NP-Za-km-z]{32,44}$/', $s ) && 32 === strlen( (string) self::decode( $s ) );
	}

	/** A fresh random key, for a Solana Pay reference. */
	public static function random_key(): string {
		return self::encode( random_bytes( 32 ) );
	}
}
