<?php
/**
 * Plugin Name:       UNO Rulebook RAG Chatbot
 * Description:       Chat widget that answers questions about the UNO rulebooks using the FastAPI RAG backend. Shortcodes: [uno_chatbot] (chat box), [uno_chatbot_home] (landing page).
 * Version:           1.6.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Mayank Bisht
 * License:           GPL-2.0-or-later
 * Text Domain:       uno-rag-chatbot
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'UNO_CHAT_VERSION', '1.6.0' );
define( 'UNO_CHAT_OPTION', 'uno_rag_chatbot_options' );
define( 'UNO_CHAT_URL', plugin_dir_url( __FILE__ ) );
define( 'UNO_CHAT_DIR', plugin_dir_path( __FILE__ ) );

require_once UNO_CHAT_DIR . 'includes/home.php';

/**
 * Plugin settings with defaults.
 */
function uno_chat_options() {
	$defaults = array(
		'backend_url' => 'http://host.docker.internal:8000',
		'api_key'     => '',
		'title'       => 'UNO Rules Assistant',
		'welcome'     => 'Hi! Ask me anything about UNO, UNO Flip, UNO Dare, UNO No Mercy or UNO All Wild.',
		'floating'    => 0,
		'per_hour'    => 30,
		'per_day'     => 300,
	);
	$saved = get_option( UNO_CHAT_OPTION, array() );
	return wp_parse_args( is_array( $saved ) ? $saved : array(), $defaults );
}

/* -------------------------------------------------------------------------
 * Settings page (Settings -> UNO Chatbot)
 * ---------------------------------------------------------------------- */
add_action( 'admin_menu', function () {
	add_options_page( 'UNO Chatbot', 'UNO Chatbot', 'manage_options', 'uno-rag-chatbot', 'uno_chat_render_settings_page' );
} );

add_action( 'admin_init', function () {
	register_setting( 'uno_chat_settings', UNO_CHAT_OPTION, array( 'sanitize_callback' => 'uno_chat_sanitize_options' ) );
	add_settings_section( 'uno_chat_main', 'Backend connection and widget', '__return_false', 'uno-rag-chatbot' );

	$fields = array(
		'backend_url' => 'Backend URL',
		'api_key'     => 'Backend API key',
		'title'       => 'Chat title',
		'welcome'     => 'Welcome message',
		'floating'    => 'Floating chat bubble',
		'per_hour'    => 'Max questions per visitor per hour',
		'per_day'     => 'Max questions per day (whole site)',
	);
	foreach ( $fields as $key => $label ) {
		add_settings_field( $key, $label, 'uno_chat_render_field', 'uno-rag-chatbot', 'uno_chat_main', array( 'key' => $key ) );
	}
} );

function uno_chat_sanitize_options( $input ) {
	$current = uno_chat_options();
	$input   = is_array( $input ) ? $input : array();
	return array(
		'backend_url' => esc_url_raw( untrailingslashit( $input['backend_url'] ?? $current['backend_url'] ) ),
		'api_key'     => sanitize_text_field( $input['api_key'] ?? $current['api_key'] ),
		'title'       => sanitize_text_field( $input['title'] ?? $current['title'] ),
		'welcome'     => sanitize_textarea_field( $input['welcome'] ?? $current['welcome'] ),
		'floating'    => empty( $input['floating'] ) ? 0 : 1,
		'per_hour'    => max( 1, min( 1000, absint( $input['per_hour'] ?? $current['per_hour'] ) ) ),
		'per_day'     => min( 100000, absint( $input['per_day'] ?? $current['per_day'] ) ),
	);
}

function uno_chat_render_field( $args ) {
	$o    = uno_chat_options();
	$key  = $args['key'];
	$name = UNO_CHAT_OPTION . '[' . $key . ']';
	switch ( $key ) {
		case 'floating':
			printf(
				'<label><input type="checkbox" name="%s" value="1" %s> Show a chat bubble in the corner of every page</label>',
				esc_attr( $name ),
				checked( 1, (int) $o['floating'], false )
			);
			break;
		case 'welcome':
			printf( '<textarea name="%s" rows="3" class="large-text">%s</textarea>', esc_attr( $name ), esc_textarea( $o['welcome'] ) );
			break;
		case 'per_hour':
			printf( '<input type="number" min="1" max="1000" name="%s" value="%d" class="small-text">', esc_attr( $name ), (int) $o['per_hour'] );
			echo '<p class="description">Protects your Google Cloud credits (a rulebook question uses about 3 model requests).</p>';
			break;
		case 'per_day':
			printf( '<input type="number" min="0" max="100000" name="%s" value="%d" class="small-text">', esc_attr( $name ), (int) $o['per_day'] );
			printf(
				'<p class="description">Total for all visitors; resets at midnight UTC. Today: %d. 0 = no limit. A question uses about 3 model requests, so keep this below the backend&rsquo;s daily cap.</p>',
				(int) uno_chat_site_count_today()
			);
			break;
		case 'api_key':
			printf( '<input type="password" name="%s" value="%s" class="regular-text" autocomplete="off">', esc_attr( $name ), esc_attr( $o['api_key'] ) );
			echo '<p class="description">Must match <code>BACKEND_API_KEY</code> in the backend <code>.env</code>. Never sent to the browser.</p>';
			break;
		case 'backend_url':
			printf( '<input type="url" name="%s" value="%s" class="regular-text">', esc_attr( $name ), esc_attr( $o['backend_url'] ) );
			echo '<p class="description">FastAPI server, e.g. <code>http://host.docker.internal:8000</code> (Docker) or <code>https://api.example.com</code>.</p>';
			break;
		default:
			printf( '<input type="text" name="%s" value="%s" class="regular-text">', esc_attr( $name ), esc_attr( $o[ $key ] ) );
	}
}

function uno_chat_render_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$o      = uno_chat_options();
	$health = wp_remote_get( $o['backend_url'] . '/health', array( 'timeout' => 8 ) );
	?>
	<div class="wrap">
		<h1>UNO Rulebook Chatbot</h1>
		<p>Add the chat to any page or post with the shortcode <code>[uno_chatbot]</code>, or enable the floating bubble below.</p>
		<?php if ( is_wp_error( $health ) ) : ?>
			<div class="notice notice-error inline"><p>Backend not reachable: <?php echo esc_html( $health->get_error_message() ); ?></p></div>
		<?php else : ?>
			<?php $h = json_decode( wp_remote_retrieve_body( $health ), true ); ?>
			<div class="notice notice-success inline"><p>
				Backend reachable &middot; model <code><?php echo esc_html( $h['llm_model'] ?? '?' ); ?></code>
				&middot; requests today <?php echo esc_html( ( $h['requests_today'] ?? '?' ) . ' / ' . ( $h['daily_request_budget'] ?? '?' ) ); ?>
				&middot; indexed chunks <?php echo esc_html( $h['documents_in_collection'] ?? '?' ); ?>
				&middot; site questions today <?php echo esc_html( uno_chat_site_count_today() . ' / ' . ( (int) $o['per_day'] ?: 'no limit' ) ); ?>
			</p></div>
		<?php endif; ?>
		<form method="post" action="options.php">
			<?php
			settings_fields( 'uno_chat_settings' );
			do_settings_sections( 'uno-rag-chatbot' );
			submit_button();
			?>
		</form>
	</div>
	<?php
}

/* -------------------------------------------------------------------------
 * Front end: shortcode + floating bubble
 * ---------------------------------------------------------------------- */
function uno_chat_enqueue() {
	if ( wp_script_is( 'uno-rag-chatbot', 'enqueued' ) ) {
		return;
	}
	$o = uno_chat_options();
	wp_enqueue_style( 'uno-rag-chatbot', UNO_CHAT_URL . 'assets/chatbot.css', array(), UNO_CHAT_VERSION );
	wp_enqueue_script( 'uno-rag-chatbot', UNO_CHAT_URL . 'assets/chatbot.js', array(), UNO_CHAT_VERSION, true );
	wp_localize_script(
		'uno-rag-chatbot',
		'UNO_CHAT',
		array(
			'restUrl' => esc_url_raw( rest_url( 'uno-chat/v1/' ) ),
			'nonce'   => wp_create_nonce( 'wp_rest' ),
			'title'       => $o['title'],
			'welcome'     => $o['welcome'],
			'subtitle'    => 'Answers from 5 UNO rulebooks',
			'suggestions' => array(
				'What does the Skip Everyone card do in UNO Flip?',
				'What is the Mercy rule in UNO No Mercy?',
				'What happens if I forget to call UNO?',
			),
		)
	);
}

/**
 * [uno_chatbot] inline chat box. layout="page" wraps it in the dark full-width chat page section.
 */
add_shortcode( 'uno_chatbot', function ( $atts ) {
	$atts = shortcode_atts( array( 'layout' => 'box' ), $atts, 'uno_chatbot' );
	uno_chat_enqueue();
	$chat = '<div class="uno-chat uno-chat--inline" data-uno-chat></div>';
	if ( 'page' !== $atts['layout'] ) {
		return $chat;
	}
	return '<div class="uno-chat-page alignfull">'
		. '<div class="uno-chat-page__intro">'
		. '<p class="uno-chat-page__eyebrow">UNO Rules Assistant</p>'
		. '<h1 class="uno-chat-page__title">Ask the rulebook</h1>'
		. '<p class="uno-chat-page__lead">Ask about any card, rule or scoring detail. Every answer comes from the official rulebooks and shows its source.</p>'
		. '</div>' . $chat . '</div>';
} );

/**
 * Pages that already show the inline chat don't need the floating bubble.
 */
function uno_chat_page_has_inline_chat() {
	$post = get_post();
	return is_singular() && $post && has_shortcode( $post->post_content, 'uno_chatbot' );
}

add_action( 'wp_enqueue_scripts', function () {
	if ( uno_chat_options()['floating'] ) {
		uno_chat_enqueue();
	}
} );

add_action( 'wp_footer', function () {
	if ( uno_chat_options()['floating'] && ! uno_chat_page_has_inline_chat() ) {
		echo '<div class="uno-chat uno-chat--floating" data-uno-chat data-floating="1"></div>';
	}
} );

/* -------------------------------------------------------------------------
 * REST proxy: browser -> WordPress -> FastAPI (backend URL + key stay server-side)
 * ---------------------------------------------------------------------- */
add_action( 'rest_api_init', function () {
	$session_arg = array(
		'type'              => 'string',
		'required'          => true,
		'sanitize_callback' => 'sanitize_text_field',
		'validate_callback' => function ( $v ) {
			return is_string( $v ) && preg_match( '/^[A-Za-z0-9_-]{1,100}$/', $v );
		},
	);
	register_rest_route(
		'uno-chat/v1',
		'/ask',
		array(
			'methods'             => 'POST',
			'callback'            => 'uno_chat_rest_ask',
			'permission_callback' => 'uno_chat_check_nonce',
			'args'                => array(
				'question'   => array(
					'type'              => 'string',
					'required'          => true,
					'sanitize_callback' => 'sanitize_textarea_field',
					'validate_callback' => function ( $v ) {
						return is_string( $v ) && '' !== trim( $v ) && mb_strlen( $v ) <= 1000;
					},
				),
				'session_id' => $session_arg,
			),
		)
	);
	register_rest_route(
		'uno-chat/v1',
		'/reset',
		array(
			'methods'             => 'POST',
			'callback'            => 'uno_chat_rest_reset',
			'permission_callback' => 'uno_chat_check_nonce',
			'args'                => array( 'session_id' => $session_arg ),
		)
	);
	register_rest_route(
		'uno-chat/v1',
		'/feedback',
		array(
			'methods'             => 'POST',
			'callback'            => 'uno_chat_rest_feedback',
			'permission_callback' => 'uno_chat_check_nonce',
			'args'                => array(
				'trace_id' => array(
					'type'              => 'string',
					'required'          => true,
					'validate_callback' => function ( $v ) {
						return is_string( $v ) && preg_match( '/^[0-9a-f]{32}$/', $v );
					},
				),
				'value'    => array(
					'type'     => 'integer',
					'required' => true,
					'enum'     => array( 1, -1 ),
				),
			),
		)
	);
} );

function uno_chat_check_nonce( WP_REST_Request $request ) {
	$nonce = $request->get_header( 'X-WP-Nonce' );
	if ( ! $nonce || ! wp_verify_nonce( $nonce, 'wp_rest' ) ) {
		return new WP_Error( 'uno_chat_bad_nonce', 'Your session expired. Please reload the page.', array( 'status' => 403 ) );
	}
	return true;
}

function uno_chat_client_ip() {
	return sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ?? 'unknown' ) );
}

/**
 * Anonymous, stable visitor id for monitoring (salted hash of the IP; the IP itself is never sent).
 */
function uno_chat_visitor_id() {
	return substr( wp_hash( uno_chat_client_ip() ), 0, 16 );
}

/**
 * Fixed one-hour window per visitor IP, stored in a transient.
 * $bucket 'rl' = questions (limit from settings), 'fb' = feedback clicks.
 */
function uno_chat_rate_limited( $bucket = 'rl', $limit = null ) {
	$o     = uno_chat_options();
	$limit = null === $limit ? (int) $o['per_hour'] : (int) $limit;
	$key   = 'uno_chat_' . $bucket . '_' . md5( uno_chat_client_ip() );
	$data  = get_transient( $key );
	$now   = time();
	if ( ! is_array( $data ) || $data['reset'] <= $now ) {
		$data = array( 'count' => 0, 'reset' => $now + HOUR_IN_SECONDS );
	}
	if ( $data['count'] >= $limit ) {
		return true;
	}
	$data['count']++;
	set_transient( $key, $data, $data['reset'] - $now );
	return false;
}

/**
 * Site-wide cap on questions per UTC day (all visitors together), so rotating IPs can't get around the per-visitor
 * limit. The counter is its own non-autoloaded option, incremented in SQL so concurrent requests don't lose counts.
 */
function uno_chat_day_option() {
	return 'uno_chat_day_' . gmdate( 'Ymd' );
}

function uno_chat_site_count_today() {
	global $wpdb;
	return (int) $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", uno_chat_day_option() ) );
}

function uno_chat_site_cap_reached() {
	global $wpdb;
	$cap = (int) uno_chat_options()['per_day'];
	if ( $cap <= 0 ) {
		return false;
	}
	if ( uno_chat_site_count_today() >= $cap ) {
		return true;
	}
	$name = uno_chat_day_option();
	if ( ! $wpdb->query( $wpdb->prepare( "UPDATE {$wpdb->options} SET option_value = option_value + 1 WHERE option_name = %s", $name ) ) ) {
		// First question of the day: drop older counters and start today's
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s AND option_name <> %s", $wpdb->esc_like( 'uno_chat_day_' ) . '%', $name ) );
		add_option( $name, 1, '', false );
	}
	return false;
}

function uno_chat_backend_request( $method, $path, $body = null ) {
	$o    = uno_chat_options();
	$args = array(
		'method'  => $method,
		'timeout' => 90,
		'headers' => array(
			'Content-Type' => 'application/json',
			'X-API-Key'    => $o['api_key'],
		),
	);
	if ( null !== $body ) {
		$args['body'] = wp_json_encode( $body );
	}
	return wp_remote_request( untrailingslashit( $o['backend_url'] ) . $path, $args );
}

function uno_chat_rest_ask( WP_REST_Request $request ) {
	if ( uno_chat_rate_limited() ) {
		return new WP_Error( 'uno_chat_rate_limited', 'You have reached the question limit for this hour. Please try again later.', array( 'status' => 429 ) );
	}
	if ( uno_chat_site_cap_reached() ) {
		return new WP_Error( 'uno_chat_daily_cap', "The assistant has reached today's question limit. Please come back tomorrow.", array( 'status' => 429 ) );
	}

	$response = uno_chat_backend_request(
		'POST',
		'/chat',
		array(
			'question'   => $request['question'],
			'session_id' => $request['session_id'],
			'visitor'    => uno_chat_visitor_id(),
		)
	);
	if ( is_wp_error( $response ) ) {
		return new WP_Error( 'uno_chat_unreachable', 'The chat service is not reachable right now. Please try again later.', array( 'status' => 502 ) );
	}

	$code = wp_remote_retrieve_response_code( $response );
	$data = json_decode( wp_remote_retrieve_body( $response ), true );

	if ( 200 === $code && is_array( $data ) && isset( $data['answer'] ) ) {
		return rest_ensure_response(
			array(
				'answer'  => (string) $data['answer'],
				'sources' => isset( $data['sources'] ) && is_array( $data['sources'] ) ? $data['sources'] : array(),
				'cached'   => ! empty( $data['cached'] ),
				'trace_id' => isset( $data['trace_id'] ) && is_string( $data['trace_id'] ) && preg_match( '/^[0-9a-f]{32}$/', $data['trace_id'] ) ? $data['trace_id'] : null,
			)
		);
	}
	if ( 429 === $code ) {
		$msg = is_array( $data ) && ! empty( $data['detail'] ) ? $data['detail'] : 'The chat service is busy. Please try again later.';
		return new WP_Error( 'uno_chat_limit', $msg, array( 'status' => 429 ) );
	}
	if ( 401 === $code ) {
		error_log( 'UNO chatbot: backend rejected the API key. Check Settings -> UNO Chatbot.' );
	}
	return new WP_Error( 'uno_chat_backend_error', 'The chat service could not answer right now. Please try again later.', array( 'status' => 502 ) );
}

function uno_chat_rest_feedback( WP_REST_Request $request ) {
	if ( uno_chat_rate_limited( 'fb', 60 ) ) {
		return new WP_Error( 'uno_chat_feedback_limited', 'Too many ratings. Please try again later.', array( 'status' => 429 ) );
	}
	$response = uno_chat_backend_request(
		'POST',
		'/feedback',
		array(
			'trace_id' => $request['trace_id'],
			'value'    => (int) $request['value'],
		)
	);
	if ( is_wp_error( $response ) || 204 !== wp_remote_retrieve_response_code( $response ) ) {
		return new WP_Error( 'uno_chat_feedback_failed', 'Could not save your rating.', array( 'status' => 502 ) );
	}
	return rest_ensure_response( array( 'ok' => true ) );
}

function uno_chat_rest_reset( WP_REST_Request $request ) {
	uno_chat_backend_request( 'DELETE', '/chat/' . rawurlencode( $request['session_id'] ) );
	return rest_ensure_response( array( 'ok' => true ) );
}
