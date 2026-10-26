<?php
/**
 * "Pay with SHIB" in the block-based checkout.
 *
 * @package ShibPayment
 */

defined( 'ABSPATH' ) || exit;

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

final class ShibPay_Blocks extends AbstractPaymentMethodType {
	protected $name = 'shibpay';

	public function initialize() {
		$this->settings = get_option( 'woocommerce_shibpay_settings', array() );
	}

	public function is_active() {
		$gateway = ShibPay_Orders::gateway();
		return $gateway && $gateway->is_available();
	}

	public function get_payment_method_script_handles() {
		wp_register_script( 'shibpay-blocks', SHIBPAY_URL . 'assets/blocks.js', array( 'wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities' ), SHIBPAY_VERSION, true );
		return array( 'shibpay-blocks' );
	}

	public function get_payment_method_data() {
		$gateway = ShibPay_Orders::gateway();
		return array(
			'title'       => $gateway ? $gateway->get_title() : __( 'Pay with SHIB', 'shibpayment' ),
			'description' => $gateway ? $gateway->get_description() : '',
			'logo'        => SHIBPAY_URL . 'assets/shib-logo.png',
			'supports'    => $gateway ? array_values( $gateway->supports ) : array( 'products' ),
		);
	}
}
