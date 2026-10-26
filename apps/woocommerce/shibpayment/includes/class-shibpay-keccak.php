<?php
/**
 * Keccak-256, as Ethereum uses it (not NIST SHA3-256, which pads differently).
 * Pure PHP on 64-bit integers, so it runs on any host without extensions.
 *
 * @package ShibPayment
 */

defined( 'ABSPATH' ) || defined( 'SHIBPAY_CLI' ) || exit;

final class ShibPay_Keccak {
	/** Rotation offsets, indexed x + 5y. */
	private const ROT = array( 0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14 );

	/** Round constants as [high, low] 32-bit halves (PHP has no unsigned 64-bit literals). */
	private const RC = array(
		array( 0x00000000, 0x00000001 ), array( 0x00000000, 0x00008082 ), array( 0x80000000, 0x0000808A ), array( 0x80000000, 0x80008000 ),
		array( 0x00000000, 0x0000808B ), array( 0x00000000, 0x80000001 ), array( 0x80000000, 0x80008081 ), array( 0x80000000, 0x00008009 ),
		array( 0x00000000, 0x0000008A ), array( 0x00000000, 0x00000088 ), array( 0x00000000, 0x80008009 ), array( 0x00000000, 0x8000000A ),
		array( 0x00000000, 0x8000808B ), array( 0x80000000, 0x0000008B ), array( 0x80000000, 0x00008089 ), array( 0x80000000, 0x00008003 ),
		array( 0x80000000, 0x00008002 ), array( 0x80000000, 0x00000080 ), array( 0x00000000, 0x0000800A ), array( 0x80000000, 0x8000000A ),
		array( 0x80000000, 0x80008081 ), array( 0x80000000, 0x00008080 ), array( 0x00000000, 0x80000001 ), array( 0x80000000, 0x80008008 ),
	);

	/** keccak256(data) as 0x-prefixed hex. */
	public static function hash( string $data ): string {
		$rate = 136;
		$data .= "\x01";
		$data .= str_repeat( "\x00", ( $rate - strlen( $data ) % $rate ) % $rate );
		$data[ strlen( $data ) - 1 ] = chr( ord( $data[ strlen( $data ) - 1 ] ) | 0x80 );

		$s = array_fill( 0, 25, 0 );
		foreach ( str_split( $data, $rate ) as $block ) {
			for ( $i = 0; $i < 17; $i++ ) {
				$s[ $i ] ^= unpack( 'P', substr( $block, $i * 8, 8 ) )[1];
			}
			self::permute( $s );
		}
		return '0x' . bin2hex( pack( 'P4', $s[0], $s[1], $s[2], $s[3] ) );
	}

	private static function rotl( int $x, int $n ): int {
		if ( 0 === $n ) {
			return $x;
		}
		return ( $x << $n ) | ( ( $x >> ( 64 - $n ) ) & ( ( 1 << $n ) - 1 ) );
	}

	private static function permute( array &$s ): void {
		static $rc = null;
		if ( null === $rc ) {
			$rc = array_map( fn( $h ) => ( $h[0] << 32 ) | $h[1], self::RC );
		}
		$b = array_fill( 0, 25, 0 );
		for ( $round = 0; $round < 24; $round++ ) {
			// Theta.
			$c = array();
			for ( $x = 0; $x < 5; $x++ ) {
				$c[ $x ] = $s[ $x ] ^ $s[ $x + 5 ] ^ $s[ $x + 10 ] ^ $s[ $x + 15 ] ^ $s[ $x + 20 ];
			}
			for ( $x = 0; $x < 5; $x++ ) {
				$d = $c[ ( $x + 4 ) % 5 ] ^ self::rotl( $c[ ( $x + 1 ) % 5 ], 1 );
				for ( $y = 0; $y < 25; $y += 5 ) {
					$s[ $x + $y ] ^= $d;
				}
			}
			// Rho and pi.
			for ( $x = 0; $x < 5; $x++ ) {
				for ( $y = 0; $y < 5; $y++ ) {
					$b[ $y + 5 * ( ( 2 * $x + 3 * $y ) % 5 ) ] = self::rotl( $s[ $x + 5 * $y ], self::ROT[ $x + 5 * $y ] );
				}
			}
			// Chi.
			for ( $y = 0; $y < 25; $y += 5 ) {
				for ( $x = 0; $x < 5; $x++ ) {
					$s[ $x + $y ] = $b[ $x + $y ] ^ ( ~$b[ ( $x + 1 ) % 5 + $y ] & $b[ ( $x + 2 ) % 5 + $y ] );
				}
			}
			// Iota.
			$s[0] ^= $rc[ $round ];
		}
	}
}
