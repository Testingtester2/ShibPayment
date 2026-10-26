<?php
// Just enough of WordPress and WooCommerce to run the plugin's order logic from
// the command line. Options, transients and orders live in memory.

define( 'ABSPATH', __DIR__ );
define( 'MINUTE_IN_SECONDS', 60 );
define( 'HOUR_IN_SECONDS', 3600 );

$GLOBALS['wp_options']    = array();
$GLOBALS['wp_transients'] = array();
$GLOBALS['wp_cron']       = array();
$GLOBALS['wc_orders']     = array();

function __( $s, $domain = null ) { return $s; }
function esc_html( $s ) { return htmlspecialchars( (string) $s, ENT_QUOTES ); }
function esc_url( $s ) { return (string) $s; }
function wp_json_encode( $v ) { return json_encode( $v ); }
function apply_filters( $hook, $value ) { return $value; }
function add_option( $k, $v ) {
	if ( array_key_exists( $k, $GLOBALS['wp_options'] ) ) {
		return false;
	}
	$GLOBALS['wp_options'][ $k ] = $v;
	return true;
}
function get_option( $k, $default = false ) { return $GLOBALS['wp_options'][ $k ] ?? $default; }
function update_option( $k, $v ) { $GLOBALS['wp_options'][ $k ] = $v; return true; }
function delete_option( $k ) { unset( $GLOBALS['wp_options'][ $k ] ); return true; }
function get_transient( $k ) { return $GLOBALS['wp_transients'][ $k ] ?? false; }
function set_transient( $k, $v ) { $GLOBALS['wp_transients'][ $k ] = $v; return true; }
function wp_next_scheduled( $hook, $args ) { return $GLOBALS['wp_cron'][ $hook . json_encode( $args ) ] ?? false; }
function wp_schedule_single_event( $t, $hook, $args ) { $GLOBALS['wp_cron'][ $hook . json_encode( $args ) ] = $t; return true; }
function wp_clear_scheduled_hook( $hook, $args ) { unset( $GLOBALS['wp_cron'][ $hook . json_encode( $args ) ] ); }
function wc_get_price_decimals() { return 2; }
function wc_format_decimal( $n, $dp ) { return number_format( (float) $n, $dp, '.', '' ); }
function wc_get_order( $id ) { return $GLOBALS['wc_orders'][ $id ] ?? false; }
function wc_get_orders( $q ) {
	$want = $q['meta_query'][0];
	$out  = array();
	foreach ( $GLOBALS['wc_orders'] as $id => $o ) {
		if ( ! in_array( $id, $q['exclude'] ?? array(), true ) && $o->get_meta( $want['key'] ) === $want['value'] ) {
			$out[] = $id;
		}
	}
	return array_slice( $out, 0, $q['limit'] );
}

class WC_Order {
	public array $meta = array();
	public string $status = 'pending';
	public array $notes = array();
	public string $transaction_id = '';

	public function __construct( public int $id, public string $total, public string $currency, public int $created ) {
		$GLOBALS['wc_orders'][ $id ] = $this;
	}
	public function get_id() { return $this->id; }
	public function get_order_number() { return (string) $this->id; }
	public function get_total() { return $this->total; }
	public function get_currency() { return $this->currency; }
	public function get_date_created() { return new DateTimeImmutable( '@' . $this->created ); }
	public function get_meta( $k ) { return $this->meta[ $k ] ?? ''; }
	public function update_meta_data( $k, $v ) { $this->meta[ $k ] = $v; }
	public function delete_meta_data( $k ) { unset( $this->meta[ $k ] ); }
	public function save() {}
	public function needs_payment() { return in_array( $this->status, array( 'pending', 'failed' ), true ); }
	public function is_paid() { return in_array( $this->status, array( 'processing', 'completed' ), true ); }
	public function add_order_note( $n ) { $this->notes[] = $n; }
	public function update_status( $s, $note = '' ) {
		$this->status = $s;
		if ( $note ) {
			$this->notes[] = $note;
		}
	}
	public function payment_complete( $tx ) {
		$this->transaction_id = $tx;
		$this->status         = 'processing';
	}
}
