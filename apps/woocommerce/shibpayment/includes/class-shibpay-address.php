<?php
/**
 * EVM addresses: validation and EIP-55 checksums.
 *
 * @package ShibPayment
 */

defined( 'ABSPATH' ) || defined( 'SHIBPAY_CLI' ) || exit;

final class ShibPay_Address {
	public const BURN = '0x000000000000000000000000000000000000dEaD';
	public const ZERO = '0x0000000000000000000000000000000000000000';

	/** EIP-55 checksummed address, or null when $s is not an address (or has a wrong checksum). */
	public static function checksum( string $s ): ?string {
		$s = trim( $s );
		if ( ! preg_match( '/^0x[0-9a-fA-F]{40}$/', $s ) ) {
			return null;
		}
		$lower = strtolower( substr( $s, 2 ) );
		$hash  = substr( ShibPay_Keccak::hash( $lower ), 2 );
		$out   = '';
		for ( $i = 0; $i < 40; $i++ ) {
			$out .= hexdec( $hash[ $i ] ) >= 8 ? strtoupper( $lower[ $i ] ) : $lower[ $i ];
		}
		$body = substr( $s, 2 );
		$mixed = strtolower( $body ) !== $body && strtoupper( $body ) !== $body;
		if ( $mixed && $body !== $out ) {
			return null;
		}
		return '0x' . $out;
	}

	public static function equal( ?string $a, ?string $b ): bool {
		return null !== $a && null !== $b && strtolower( $a ) === strtolower( $b );
	}

	/** Address in a 32-byte log topic. */
	public static function from_topic( string $topic ): string {
		return '0x' . substr( strtolower( $topic ), -40 );
	}

	/**
	 * Checks a merchant's receiving address. Returns it checksummed, or throws with
	 * a plain-language message. The zero and burn addresses are refused: a typo
	 * there would burn every payment.
	 */
	public static function validate_merchant( string $s ): string {
		$addr = self::checksum( $s );
		if ( null === $addr ) {
			throw new InvalidArgumentException( 'That is not a valid wallet address (0x followed by 40 characters).' );
		}
		if ( self::equal( $addr, self::ZERO ) || self::equal( $addr, self::BURN ) ) {
			throw new InvalidArgumentException( 'That address cannot receive payments.' );
		}
		return $addr;
	}
}
