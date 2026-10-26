<?php
/**
 * JSON over HTTP: WordPress's HTTP API inside WordPress, curl elsewhere (tests).
 *
 * @package ShibPayment
 */

defined( 'ABSPATH' ) || defined( 'SHIBPAY_CLI' ) || exit;

final class ShibPay_Http {
	/** Decoded JSON response, or null on any network, HTTP or parse error. */
	public static function json( string $url, ?array $body = null, int $timeout = 10 ) {
		if ( function_exists( 'wp_remote_request' ) ) {
			$res = wp_remote_request(
				$url,
				array(
					'method'  => null === $body ? 'GET' : 'POST',
					'timeout' => $timeout,
					'headers' => array(
						'Content-Type' => 'application/json',
						'Accept'       => 'application/json',
					),
					'body'    => null === $body ? null : wp_json_encode( $body ),
				)
			);
			if ( is_wp_error( $res ) || wp_remote_retrieve_response_code( $res ) >= 400 ) {
				return null;
			}
			return json_decode( wp_remote_retrieve_body( $res ), true );
		}
		$ch = curl_init( $url );
		curl_setopt_array(
			$ch,
			array(
				CURLOPT_RETURNTRANSFER => true,
				CURLOPT_TIMEOUT        => $timeout,
				CURLOPT_HTTPHEADER     => array( 'Content-Type: application/json', 'Accept: application/json' ),
			)
		);
		if ( null !== $body ) {
			curl_setopt( $ch, CURLOPT_POSTFIELDS, json_encode( $body ) );
		}
		$raw  = curl_exec( $ch );
		$code = curl_getinfo( $ch, CURLINFO_HTTP_CODE );
		curl_close( $ch );
		return false === $raw || $code >= 400 ? null : json_decode( $raw, true );
	}
}
