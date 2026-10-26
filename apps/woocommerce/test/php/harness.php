<?php
// Runs the plugin's PHP for the vitest suite: reads one JSON job from stdin,
// prints the answer as JSON.
require __DIR__ . '/wp-stubs.php';
$plugin = dirname( __DIR__, 2 ) . '/shibpayment/includes';
foreach ( array( 'keccak', 'base58', 'uint', 'address', 'http', 'registry', 'rpc', 'verifier', 'solana', 'prices', 'names', 'orders' ) as $f ) {
	require_once "$plugin/class-shibpay-$f.php";
}

$job = json_decode( stream_get_contents( STDIN ), true );
// The local test chain, and nowhere for every other network (no public RPCs from tests).
foreach ( ShibPay_Registry::chains() as $c ) {
	ShibPay_Rpc::$override[ $c['chainId'] ] = array( $job['rpc'][ $c['chainId'] ] ?? 'http://127.0.0.1:1' );
}
ShibPay_Rpc::$override['solana'] = array( $job['rpc']['solana'] ?? 'http://127.0.0.1:1' );

switch ( $job['op'] ) {
	case 'keccak':
		$out = array_map( fn( $s ) => ShibPay_Keccak::hash( $s ), $job['data'] );
		break;
	case 'base58':
		$out = array(
			'encoded' => array_map( fn( $hex ) => ShibPay_Base58::encode( (string) hex2bin( $hex ) ), $job['hex'] ),
			'decoded' => array_map( fn( $s ) => bin2hex( (string) ShibPay_Base58::decode( $s ) ), $job['b58'] ),
			'keys'    => array_map( fn( $s ) => ShibPay_Base58::is_key( $s ), $job['keys'] ),
			'sigs'    => array_map( fn( $s ) => ShibPay_Solana::is_signature( $s ), $job['keys'] ),
			'random'  => ShibPay_Base58::random_key(),
		);
		break;
	case 'checksum':
		$out = array_map( fn( $s ) => ShibPay_Address::checksum( $s ), $job['data'] );
		break;
	case 'uint':
		$out = array_map(
			fn( $c ) => match ( $c[0] ) {
				'from_hex' => ShibPay_Uint::from_hex( $c[1] ),
				'add'      => ShibPay_Uint::add( $c[1], $c[2] ),
				'mul'      => ShibPay_Uint::mul( $c[1], $c[2] ),
				'div'      => ShibPay_Uint::div( $c[1], $c[2] ),
				'cmp'      => ShibPay_Uint::cmp( $c[1], $c[2] ),
				'parse'    => ShibPay_Uint::parse_units( $c[1], $c[2] ),
				'format'   => ShibPay_Uint::format_units( $c[1], $c[2], $c[3] ),
				'has_tag'  => ShibPay_Verifier::has_tag( $c[1], 18, $c[2] ),
				'min'      => ShibPay_Prices::min_amount( $c[1], $c[2], 18, $c[3] ),
			},
			$job['cases']
		);
		break;
	case 'verify':
		$v   = new ShibPay_Verifier( new ShibPay_Rpc() );
		$out = $v->verify( $job['tx'], $job['expected'] );
		break;
	case 'orders':
		// Orders and prices, then a list of confirm() calls; returns each answer and the orders' state.
		set_transient( 'shibpay_prices_' . strtolower( $job['currency'] ), $job['prices'] );
		foreach ( $job['orders'] as $o ) {
			$order = new WC_Order( $o['id'], $o['total'], $job['currency'], $o['created'] ?? time() );
			$order->meta = $o['meta'];
		}
		$out = array( 'answers' => array() );
		foreach ( $job['calls'] as $c ) {
			if ( 'recheck' === ( $c['call'] ?? '' ) ) {
				ShibPay_Orders::recheck( $c['order'] );
				$out['answers'][] = null;
			} elseif ( 'watch' === ( $c['call'] ?? '' ) ) {
				ShibPay_Orders::watch_solana( $c['order'] );
				$out['answers'][] = null;
			} else {
				$out['answers'][] = ShibPay_Orders::confirm( wc_get_order( $c['order'] ), $c['tx'], $c['chain'] ?? null, $c['token'] ?? null );
			}
		}
		$out['orders'] = array_map(
			fn( $o ) => array(
				'status' => $o->status,
				'tx'     => $o->transaction_id,
				'meta'   => $o->meta,
				'notes'  => $o->notes,
			),
			$GLOBALS['wc_orders']
		);
		$out['pledged'] = get_option( 'shibpay_pledged', array() );
		$out['cron']    = array_keys( $GLOBALS['wp_cron'] );
		break;
}
echo json_encode( $out );
