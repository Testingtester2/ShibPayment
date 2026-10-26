<?php
/**
 * Read-only JSON-RPC over each network's public endpoints, trying the next
 * endpoint when one fails. Answers are remembered for the rest of the request.
 *
 * @package ShibPayment
 */

defined( 'ABSPATH' ) || defined( 'SHIBPAY_CLI' ) || exit;

class ShibPay_Rpc {
	/** chainId => list of URLs, replacing the registry's (tests point this at a local chain). */
	public static array $override = array();

	private array $memo = array();

	/** Thrown when no endpoint answered. */
	public const UNREACHABLE = 'unreachable';

	public function urls( int $chain_id ): array {
		$urls = self::$override[ $chain_id ] ?? ( ShibPay_Registry::chain( $chain_id )['rpcUrls'] ?? array() );
		return function_exists( 'apply_filters' ) ? (array) apply_filters( 'shibpay_rpc_urls', $urls, $chain_id ) : $urls;
	}

	/**
	 * The call's result (null is a valid result: "no such transaction").
	 *
	 * @throws RuntimeException When every endpoint failed.
	 */
	public function call( int $chain_id, string $method, array $params = array() ) {
		$key = $chain_id . $method . json_encode( $params );
		if ( 'eth_blockNumber' !== $method && array_key_exists( $key, $this->memo ) ) {
			return $this->memo[ $key ];
		}
		foreach ( $this->urls( $chain_id ) as $url ) {
			$res = ShibPay_Http::json(
				$url,
				array(
					'jsonrpc' => '2.0',
					'id'      => 1,
					'method'  => $method,
					'params'  => $params,
				)
			);
			if ( is_array( $res ) && array_key_exists( 'result', $res ) ) {
				return $this->memo[ $key ] = $res['result'];
			}
		}
		throw new RuntimeException( self::UNREACHABLE );
	}
}
