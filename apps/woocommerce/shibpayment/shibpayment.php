<?php
/**
 * Plugin Name:       ShibPayment for WooCommerce
 * Plugin URI:        https://shibpayments.shibfun.app
 * Description:       Pay with SHIB at checkout. Customers pay with SHIB, BONE, LEASH or TREAT on 13 networks, or SHIB on Solana, straight into your own wallet. No fees.
 * Version:           0.1.0
 * Requires at least: 6.3
 * Requires PHP:      8.0
 * Requires Plugins:  woocommerce
 * WC requires at least: 8.0
 * Author:            ShibPayment
 * License:           MIT
 * Text Domain:       shibpayment
 *
 * @package ShibPayment
 */

defined( 'ABSPATH' ) || exit;

define( 'SHIBPAY_VERSION', '0.1.0' );
define( 'SHIBPAY_URL', plugin_dir_url( __FILE__ ) );
define( 'SHIBPAY_SITE', 'https://shibpayments.shibfun.app' );

foreach ( array( 'keccak', 'base58', 'uint', 'address', 'http', 'registry', 'rpc', 'verifier', 'solana', 'prices', 'names' ) as $shibpay_file ) {
	require_once __DIR__ . "/includes/class-shibpay-$shibpay_file.php";
}

add_action(
	'before_woocommerce_init',
	function () {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', __FILE__, true );
		}
	}
);

add_action(
	'plugins_loaded',
	function () {
		if ( ! class_exists( 'WC_Payment_Gateway' ) ) {
			return;
		}
		require_once __DIR__ . '/includes/class-shibpay-orders.php';
		require_once __DIR__ . '/includes/class-wc-gateway-shibpay.php';
		add_filter(
			'woocommerce_payment_gateways',
			function ( $gateways ) {
				$gateways[] = 'WC_Gateway_ShibPay';
				return $gateways;
			}
		);
	}
);

add_action(
	'woocommerce_blocks_payment_method_type_registration',
	function ( $registry ) {
		require_once __DIR__ . '/includes/class-shibpay-blocks.php';
		$registry->register( new ShibPay_Blocks() );
	}
);

add_action( 'shibpay_recheck', array( 'ShibPay_Orders', 'recheck' ) );
add_action( 'shibpay_watch_solana', array( 'ShibPay_Orders', 'watch_solana' ) );

// The shop's own Solana connection, when set, before the busy public one.
add_filter(
	'shibpay_rpc_urls',
	function ( $urls, $chain ) {
		$custom = 'solana' === $chain ? ( get_option( 'woocommerce_shibpay_settings', array() )['solana_rpc'] ?? '' ) : '';
		return $custom ? array_merge( array( $custom ), $urls ) : $urls;
	},
	10,
	2
);

add_action(
	'rest_api_init',
	function () {
		if ( ! class_exists( 'ShibPay_Orders' ) ) {
			return;
		}
		$order_for = function ( WP_REST_Request $req ) {
			$order = wc_get_order( (int) $req['order'] );
			return $order && 'shibpay' === $order->get_payment_method() && hash_equals( $order->get_order_key(), (string) $req['key'] ) ? $order : null;
		};
		$args = array(
			'order' => array(
				'required' => true,
				'type'     => 'integer',
			),
			'key'   => array(
				'required' => true,
				'type'     => 'string',
			),
		);
		// The order key, from the buyer's own pay link, is what authorises these calls.
		register_rest_route(
			'shibpay/v1',
			'/confirm',
			array(
				'methods'             => 'POST',
				'permission_callback' => '__return_true',
				'args'                => $args + array(
					'tx'    => array(
						'required' => true,
						'type'     => 'string',
					),
					'chain' => array( 'type' => array( 'integer', 'string' ) ),
					'token' => array(
						'type' => 'string',
						'enum' => ShibPay_Registry::symbols(),
					),
				),
				'callback'            => function ( WP_REST_Request $req ) use ( $order_for ) {
					$order = $order_for( $req );
					if ( ! $order ) {
						return new WP_Error( 'shibpay_order', 'Order not found', array( 'status' => 404 ) );
					}
					return ShibPay_Orders::confirm( $order, (string) $req['tx'], $req['chain'] ?: null, $req['token'] ?: null );
				},
			)
		);
		register_rest_route(
			'shibpay/v1',
			'/status',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true',
				'args'                => $args,
				'callback'            => function ( WP_REST_Request $req ) use ( $order_for ) {
					$order = $order_for( $req );
					return $order ? ShibPay_Orders::status( $order ) : new WP_Error( 'shibpay_order', 'Order not found', array( 'status' => 404 ) );
				},
			)
		);
	}
);

// "I've burned it": clears the pledged-burn total on the settings page.
add_action(
	'admin_post_shibpay_burned',
	function () {
		check_admin_referer( 'shibpay_burned' );
		if ( current_user_can( 'manage_woocommerce' ) ) {
			update_option( 'shibpay_pledged', array(), false );
		}
		wp_safe_redirect( admin_url( 'admin.php?page=wc-settings&tab=checkout&section=shibpay' ) );
		exit;
	}
);

add_filter(
	'plugin_action_links_' . plugin_basename( __FILE__ ),
	function ( $links ) {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'admin.php?page=wc-settings&tab=checkout&section=shibpay' ) ) . '">' . esc_html__( 'Settings', 'shibpayment' ) . '</a>' );
		return $links;
	}
);
