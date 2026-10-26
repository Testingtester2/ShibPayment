<?php
/**
 * The "Pay with SHIB" payment method.
 *
 * @package ShibPayment
 */

defined( 'ABSPATH' ) || exit;

class WC_Gateway_ShibPay extends WC_Payment_Gateway {
	/** Address a .shib name resolved to while saving settings. */
	private ?string $resolved = null;

	public function __construct() {
		$this->id                 = 'shibpay';
		$this->icon               = SHIBPAY_URL . 'assets/shib-logo.png';
		$this->has_fields         = false;
		$this->method_title       = __( 'Pay with SHIB (ShibPayment)', 'shibpayment' );
		$this->method_description = __( 'Customers pay with SHIB, BONE, LEASH or TREAT, straight into your own wallet. No fees, no account.', 'shibpayment' );
		$this->supports           = array( 'products' );

		$this->init_form_fields();
		$this->init_settings();
		$this->title       = $this->get_option( 'title' );
		$this->description = $this->get_option( 'description' );

		add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );
		add_action( 'woocommerce_receipt_' . $this->id, array( $this, 'receipt_page' ) );
		add_action( 'woocommerce_thankyou_' . $this->id, array( $this, 'thankyou_page' ) );
	}

	public function init_form_fields() {
		$tokens = array_combine( ShibPay_Registry::symbols(), ShibPay_Registry::symbols() );
		$this->form_fields = array(
			'enabled'     => array(
				'title'   => __( 'Turn on', 'shibpayment' ),
				'type'    => 'checkbox',
				'label'   => __( 'Show "Pay with SHIB" at checkout', 'shibpayment' ),
				'default' => 'no',
			),
			'wallet'      => array(
				'title'       => __( 'Your wallet', 'shibpayment' ),
				'type'        => 'text',
				'description' => __( 'Where your money goes. Paste your ShibWallet address (starts with 0x) or your .shib name. Use your own wallet, not an exchange deposit address: exchanges often don\'t credit tokens sent on side networks.', 'shibpayment' ),
				'placeholder' => '0x… or yourname.shib',
				'default'     => '',
			),
			'burn'        => array(
				'title'             => __( 'Burn % of each sale', 'shibpayment' ),
				'type'              => 'number',
				'description'       => __( 'Optional. Leave at 0 to keep everything. On Ethereum the burn happens in the payment itself. On other networks you are paid in full and burn your share later with the burn helper, because burns only count on Ethereum.', 'shibpayment' ),
				'default'           => '0',
				'custom_attributes' => array(
					'min'  => '0',
					'max'  => '100',
					'step' => '0.01',
				),
			),
			'title'       => array(
				'title'   => __( 'Name at checkout', 'shibpayment' ),
				'type'    => 'text',
				'default' => __( 'Pay with SHIB', 'shibpayment' ),
			),
			'description' => array(
				'title'   => __( 'Text at checkout', 'shibpayment' ),
				'type'    => 'textarea',
				'default' => __( 'Pay with SHIB, BONE, LEASH or TREAT from your crypto wallet, on Shibarium, Ethereum and 11 more networks.', 'shibpayment' ),
			),
			'tokens'      => array(
				'title'       => __( 'Tokens you accept', 'shibpayment' ),
				'type'        => 'multiselect',
				'class'       => 'wc-enhanced-select',
				'options'     => $tokens,
				'default'     => array_keys( $tokens ),
				'description' => __( 'All four are on, which is best for most shops.', 'shibpayment' ),
			),
			'address'     => array(
				'type'    => 'hidden',
				'default' => '',
			),
		);
	}

	public function generate_hidden_html( $key, $data ) {
		return '';
	}

	/** Set only from the wallet field, never from the form. */
	public function validate_address_field( $key, $value ) {
		return $this->get_option( 'address' );
	}

	public function validate_wallet_field( $key, $value ) {
		$value = trim( (string) $value );
		if ( '' === $value ) {
			$this->resolved = '';
			return '';
		}
		if ( ShibPay_Names::is_shib_name( $value ) ) {
			$addr = ShibPay_Names::resolve( $value );
			if ( ! $addr ) {
				/* translators: %s: .shib name */
				self::refuse( sprintf( __( 'We couldn\'t find the name %s. Check the spelling, or paste your 0x address instead.', 'shibpayment' ), $value ) );
			}
			$this->resolved = ShibPay_Address::validate_merchant( $addr );
			return strtolower( $value );
		}
		try {
			$this->resolved = ShibPay_Address::validate_merchant( $value );
		} catch ( InvalidArgumentException $e ) {
			self::refuse( $e->getMessage() );
		}
		return $this->resolved;
	}

	public function validate_burn_field( $key, $value ) {
		$value = trim( (string) $value );
		if ( '' === $value ) {
			return '0';
		}
		if ( ! preg_match( '/^\d+(\.\d{1,2})?$/', $value ) || (float) $value > 100 ) {
			self::refuse( __( 'Burn must be a number from 0 to 100.', 'shibpayment' ) );
		}
		return $value;
	}

	/** Shows $message on the settings page and keeps the field's saved value. */
	private static function refuse( string $message ): void {
		if ( class_exists( 'WC_Admin_Settings' ) ) {
			WC_Admin_Settings::add_error( $message );
		}
		throw new Exception( esc_html( $message ) );
	}

	public function process_admin_options() {
		$saved = parent::process_admin_options();
		if ( null !== $this->resolved ) {
			$this->settings['address'] = $this->resolved;
			update_option( $this->get_option_key(), apply_filters( 'woocommerce_settings_api_sanitized_fields_' . $this->id, $this->settings ), 'yes' );
		}
		return $saved;
	}

	public function merchant_address(): string {
		return (string) $this->get_option( 'address' );
	}

	public function burn_bps(): int {
		return (int) round( (float) $this->get_option( 'burn', '0' ) * 100 );
	}

	/** @return string[] */
	public function tokens(): array {
		$t = array_values( array_intersect( ShibPay_Registry::symbols(), (array) $this->get_option( 'tokens', array() ) ) );
		return $t ?: ShibPay_Registry::symbols();
	}

	public function is_available() {
		return parent::is_available() && '' !== $this->merchant_address();
	}

	public function admin_options() {
		$wallet  = $this->get_option( 'wallet' );
		$address = $this->merchant_address();
		$pledged = ShibPay_Orders::pledged();
		$burn    = esc_url( SHIBPAY_SITE . '/burn.html' );
		echo '<h2>' . esc_html( $this->get_method_title() ) . '</h2>';
		echo '<p>' . esc_html( $this->get_method_description() ) . '</p>';
		echo '<div class="shibpay-admin" style="max-width:720px;padding:12px 16px;background:#fff;border:1px solid #dcdcde;border-left:4px solid #ff6900;margin:12px 0">';
		if ( '' === $address ) {
			echo '<p><strong>' . esc_html__( 'Two steps and you\'re done:', 'shibpayment' ) . '</strong> ' . esc_html__( 'paste your wallet below, tick "Turn on", and save.', 'shibpayment' ) . '</p>';
		} else {
			echo '<p>' . esc_html__( 'Payments go to', 'shibpayment' ) . ' <code>' . esc_html( $address ) . '</code>';
			if ( $wallet && strtolower( $wallet ) !== strtolower( $address ) ) {
				echo ' (' . esc_html( $wallet ) . ')';
			}
			echo '</p>';
		}
		$currency = get_woocommerce_currency();
		if ( ! in_array( $currency, ShibPay_Registry::symbols(), true ) ) {
			$key = 'shibpay_currency_ok_' . strtolower( $currency );
			$ok  = get_transient( $key );
			if ( false === $ok ) {
				$ok = ShibPay_Prices::fetch( $currency, array( 'SHIB' ) ) ? 'yes' : 'no';
				set_transient( $key, $ok, HOUR_IN_SECONDS );
			}
			if ( 'no' === $ok ) {
				/* translators: %s: currency code */
				echo '<p style="color:#b32d2e">' . esc_html( sprintf( __( 'We couldn\'t get a SHIB price in %s right now. If this keeps happening, your shop currency may not be supported, and customers won\'t see a price.', 'shibpayment' ), $currency ) ) . '</p>';
			}
		}
		$owed = array_filter( $pledged, fn( $a ) => '0' !== ShibPay_Uint::norm( $a ) );
		if ( $owed ) {
			$parts = array();
			foreach ( $owed as $sym => $amount ) {
				$parts[] = ShibPay_Uint::format_units( $amount, 18, 2 ) . ' ' . $sym;
			}
			echo '<p><strong>' . esc_html__( 'Burn pledged so far:', 'shibpayment' ) . '</strong> ' . esc_html( implode( ', ', $parts ) ) . '. ';
			/* translators: %s: link to the burn helper */
			echo wp_kses_post( sprintf( __( 'Burn it on Ethereum with the <a href="%s" target="_blank" rel="noopener">burn helper</a>, then', 'shibpayment' ), $burn ) ) . ' ';
			$reset = wp_nonce_url( admin_url( 'admin-post.php?action=shibpay_burned' ), 'shibpay_burned' );
			echo '<a href="' . esc_url( $reset ) . '">' . esc_html__( 'mark it as burned', 'shibpayment' ) . '</a>.</p>';
		}
		echo '</div>';
		echo '<table class="form-table">';
		$this->generate_settings_html();
		echo '</table>';
	}

	public function process_payment( $order_id ) {
		$order = wc_get_order( $order_id );
		ShibPay_Orders::prepare( $order, $this );
		return array(
			'result'   => 'success',
			'redirect' => $order->get_checkout_payment_url( true ),
		);
	}

	public function get_transaction_url( $order ) {
		$chain = (int) $order->get_meta( '_shibpay_chain' );
		return $chain ? ShibPay_Registry::tx_url( $chain, $order->get_transaction_id() ) : '';
	}

	/** Order-pay page: the button, filled from the order, opens straight away. */
	public function receipt_page( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order ) {
			return;
		}
		if ( ! $order->get_meta( '_shibpay_merchant' ) ) {
			ShibPay_Orders::prepare( $order, $this );
		}
		$status = ShibPay_Orders::status( $order );
		if ( 'unpaid' !== $status['status'] ) {
			echo '<p class="shibpay-status">' . esc_html( $status['message'] ) . '</p>';
			echo '<p><a class="button" href="' . esc_url( $this->get_return_url( $order ) ) . '">' . esc_html__( 'See your order', 'shibpayment' ) . '</a></p>';
			return;
		}
		ShibPay_Orders::refresh_quote( $order );
		self::enqueue( $order, $this->get_return_url( $order ) );

		$bps = (int) $order->get_meta( '_shibpay_burn_bps' );
		?>
		<div class="shibpay-wc" style="margin:1em 0">
			<p><?php esc_html_e( 'Press the button to pay from your wallet. On a phone, you can also scan a QR code with your wallet app.', 'shibpayment' ); ?></p>
			<shib-pay
				to="<?php echo esc_attr( $order->get_meta( '_shibpay_merchant' ) ); ?>"
				amount="<?php echo esc_attr( wc_format_decimal( $order->get_total(), wc_get_price_decimals() ) ); ?>"
				currency="<?php echo esc_attr( $order->get_currency() ); ?>"
				burn="<?php echo esc_attr( (string) ( $bps / 100 ) ); ?>"
				order="<?php echo esc_attr( ShibPay_Orders::reference( $order ) ); ?>"
				tag="<?php echo esc_attr( (string) $order->get_meta( '_shibpay_tag' ) ); ?>"
				tokens="<?php echo esc_attr( (string) $order->get_meta( '_shibpay_tokens' ) ); ?>"
				label="<?php echo esc_attr( wp_specialchars_decode( get_bloginfo( 'name' ), ENT_QUOTES ) ); ?>"
				return-url="<?php echo esc_attr( $this->get_return_url( $order ) ); ?>"
			></shib-pay>
			<p class="shibpay-status" role="status" aria-live="polite"></p>
			<details class="shibpay-paste" style="margin-top:1.5em">
				<summary><?php esc_html_e( 'Already paid? Paste your transaction', 'shibpayment' ); ?></summary>
				<form class="shibpay-paste-form" style="margin-top:.75em">
					<label for="shibpay-tx"><?php esc_html_e( 'The transaction link or hash from your wallet', 'shibpayment' ); ?></label>
					<input id="shibpay-tx" name="tx" type="text" class="input-text" style="width:100%" placeholder="https://shibariumscan.io/tx/0x…" autocomplete="off" required />
					<button type="submit" class="button" style="margin-top:.5em"><?php esc_html_e( 'Check my payment', 'shibpayment' ); ?></button>
				</form>
			</details>
		</div>
		<?php
	}

	/** Thank-you page: picks up a payment from the button's return link, and shows a waiting payment's progress. */
	public function thankyou_page( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order ) {
			return;
		}
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only hint; the payment itself is checked on-chain.
		$tx = isset( $_GET['shibpay_tx'] ) ? sanitize_text_field( wp_unslash( $_GET['shibpay_tx'] ) ) : '';
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$chain = isset( $_GET['shibpay_chain'] ) ? absint( $_GET['shibpay_chain'] ) : null;
		if ( $tx && $order->needs_payment() && ! $order->get_meta( '_shibpay_tx' ) ) {
			ShibPay_Orders::confirm( $order, $tx, $chain ?: null );
		}
		$status = ShibPay_Orders::status( $order );
		if ( in_array( $status['status'], array( 'paid', 'closed' ), true ) ) {
			return;
		}
		if ( 'unpaid' === $status['status'] ) {
			echo '<p><a class="button" href="' . esc_url( $order->get_checkout_payment_url( true ) ) . '">' . esc_html__( 'Pay with SHIB', 'shibpayment' ) . '</a></p>';
			return;
		}
		self::enqueue( $order, '' );
		echo '<p class="shibpay-status" role="status" aria-live="polite" data-watch="1">' . esc_html( $status['message'] ) . '</p>';
	}

	private static function enqueue( WC_Order $order, string $done_url ): void {
		wp_enqueue_script( 'shibpay-button', SHIBPAY_URL . 'assets/shib-pay.js', array(), SHIBPAY_VERSION, true );
		wp_enqueue_script( 'shibpay-checkout', SHIBPAY_URL . 'assets/checkout.js', array( 'shibpay-button' ), SHIBPAY_VERSION, true );
		wp_localize_script(
			'shibpay-checkout',
			'shibpayCheckout',
			array(
				'api'     => esc_url_raw( rest_url( 'shibpay/v1/' ) ),
				'order'   => $order->get_id(),
				'key'     => $order->get_order_key(),
				'doneUrl' => $done_url,
				'text'    => array(
					'checking' => __( 'Checking your payment…', 'shibpayment' ),
					'error'    => __( 'We couldn\'t reach the shop. Your payment is safe; refresh the page in a minute.', 'shibpayment' ),
				),
			)
		);
	}
}
