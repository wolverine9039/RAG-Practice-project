<?php
/**
 * Saves the UNO chatbot plugin settings. Reads {"backend_url": ..., "api_key": ...} from stdin so the key never
 * appears on a command line. Keeps settings changed later in wp-admin (title, limits, ...) on re-runs.
 * Run with: wp eval-file /setup/plugin-options.php < plugin-settings.json
 */
$in = json_decode( file_get_contents( 'php://stdin' ), true );
if ( ! is_array( $in ) || empty( $in['backend_url'] ) || empty( $in['api_key'] ) ) {
	WP_CLI::error( 'Expected JSON with backend_url and api_key on stdin.' );
}
$defaults = array(
	'title'    => 'UNO Rules Assistant',
	'welcome'  => 'Hi! Ask me anything about UNO, UNO Flip, UNO Dare, UNO No Mercy or UNO All Wild.',
	'floating' => 1,
	'per_hour' => 10,
);
$current = get_option( 'uno_rag_chatbot_options', array() );
$options = array_merge( $defaults, is_array( $current ) ? $current : array(), array(
	'backend_url' => untrailingslashit( esc_url_raw( $in['backend_url'] ) ),
	'api_key'     => sanitize_text_field( $in['api_key'] ),
) );
update_option( 'uno_rag_chatbot_options', $options );
echo 'Plugin settings saved: backend_url=' . $options['backend_url'] . ', per_hour=' . $options['per_hour'] . "\n";
