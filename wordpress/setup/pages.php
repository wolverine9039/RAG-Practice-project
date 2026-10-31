<?php
/**
 * Creates the UNO chatbot pages and menu. Shared by the local setup (wordpress/setup.ps1) and the
 * Google Cloud setup (deploy/wordpress/vm-setup.sh). Safe to run again.
 * Run with: wp eval-file /setup/pages.php
 */

// Chat page: dark full-width layout and no theme title
$chat = get_page_by_path( 'uno-rules-chat' );
$chat_id = $chat ? $chat->ID : wp_insert_post( array(
	'post_type'   => 'page',
	'post_status' => 'publish',
	'post_title'  => 'UNO Rules Chat',
	'post_name'   => 'uno-rules-chat',
) );
wp_update_post( array( 'ID' => $chat_id, 'post_content' => "<!-- wp:shortcode -->\n[uno_chatbot layout=\"page\"]\n<!-- /wp:shortcode -->" ) );
update_post_meta( $chat_id, '_wp_page_template', 'page-no-title' );

// Home page with [uno_chatbot_home] (landing page about the chatbot) as the site's front page
$home = get_page_by_path( 'home' );
$id   = $home ? $home->ID : wp_insert_post( array(
	'post_type'    => 'page',
	'post_status'  => 'publish',
	'post_title'   => 'Home',
	'post_name'    => 'home',
	'post_content' => "<!-- wp:shortcode -->\n[uno_chatbot_home]\n<!-- /wp:shortcode -->",
) );
$templates = array_keys( wp_get_theme()->get_page_templates() );
$block     = function_exists( 'get_block_templates' ) ? wp_list_pluck( get_block_templates( array(), 'wp_template' ), 'slug' ) : array();
if ( in_array( 'page-no-title', array_merge( $templates, $block ), true ) ) {
	update_post_meta( $id, '_wp_page_template', 'page-no-title' );
}
update_option( 'show_on_front', 'page' );
update_option( 'page_on_front', $id );

// Header menu with only "Home" (otherwise the theme lists every page, e.g. Sample Page and the chat page)
$menu = get_posts( array( 'post_type' => 'wp_navigation', 'title' => 'Main menu', 'post_status' => 'publish', 'numberposts' => 1 ) );
if ( ! $menu ) {
	wp_insert_post( array(
		'post_type'    => 'wp_navigation',
		'post_status'  => 'publish',
		'post_title'   => 'Main menu',
		'post_content' => '<!-- wp:navigation-link {"label":"Home","url":"' . home_url( '/' ) . '","kind":"custom","isTopLevelLink":true} /-->',
	) );
}

echo "Pages ready: home (ID $id, front page), uno-rules-chat (ID $chat_id)\n";
