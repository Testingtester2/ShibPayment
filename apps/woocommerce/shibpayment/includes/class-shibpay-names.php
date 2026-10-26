<?php
/**
 * .shib names -> addresses, with the same resolvers as ShibWallet and
 * resolveShibName() in @shibpay/core, in the same order.
 *
 * @package ShibPayment
 */

defined( 'ABSPATH' ) || defined( 'SHIBPAY_CLI' ) || exit;

final class ShibPay_Names {
	public static function is_shib_name( string $s ): bool {
		return (bool) preg_match( '/^[a-z0-9_-]+\.shib$/i', trim( $s ) );
	}

	/** Checksummed address, or null when the name doesn't resolve. */
	public static function resolve( string $name ): ?string {
		$n     = strtolower( trim( $name ) );
		$tries = array(
			function () use ( $n ) {
				$j = ShibPay_Http::json( 'https://shibwatch.vercel.app/api/name?q=' . rawurlencode( $n ), null, 8 );
				return ( $j['registered'] ?? null ) === false ? null : ( $j['owner'] ?? null );
			},
			function () use ( $n ) {
				$j = ShibPay_Http::json( 'https://shibariumscan.io/api/v2/search?q=' . rawurlencode( $n ), null, 8 );
				foreach ( $j['items'] ?? array() as $it ) {
					if ( 'ens_domain' === ( $it['type'] ?? '' ) && strtolower( $it['ens_info']['name'] ?? '' ) === $n ) {
						return $it['address_hash'] ?? null;
					}
				}
				return null;
			},
			function () use ( $n ) {
				foreach ( array( 'vana', 'interstellar.xyz' ) as $domain ) {
					foreach ( array( '_w3addr', '_web3connect' ) as $prefix ) {
						$j = ShibPay_Http::json( 'https://cloudflare-dns.com/dns-query?name=' . rawurlencode( "$prefix.$n.$domain" ) . '&type=TXT', null, 8 );
						foreach ( $j['Answer'] ?? array() as $a ) {
							if ( 16 === ( $a['type'] ?? 0 ) && preg_match( '/^(?:BONE:|WALLET\.BONE=)(0x[0-9a-fA-F]{40})$/i', str_replace( '"', '', $a['data'] ), $m ) ) {
								return $m[1];
							}
						}
					}
				}
				return null;
			},
		);
		foreach ( $tries as $try ) {
			$addr = $try();
			if ( is_string( $addr ) && null !== ShibPay_Address::checksum( strtolower( $addr ) ) ) {
				return ShibPay_Address::checksum( strtolower( $addr ) );
			}
		}
		return null;
	}
}
