<?php
/**
 * Home / landing page: [uno_chatbot_home].
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * URL of the page that holds the [uno_chatbot] shortcode (created by setup.ps1).
 */
function uno_chat_page_url() {
	$page = get_page_by_path( 'uno-rules-chat' );
	return $page ? get_permalink( $page ) : home_url( '/uno-rules-chat/' );
}

add_shortcode( 'uno_chatbot_home', function () {
	wp_enqueue_style( 'uno-home', UNO_CHAT_URL . 'assets/home.css', array(), UNO_CHAT_VERSION );
	$chat_url = uno_chat_page_url();

	$rulebooks = array(
		array( 'UNO Flip', 'Light and dark sides, Draw Five, Skip Everyone, Wild Draw Color.' ),
		array( 'UNO No Mercy', 'Stacking, the Mercy rule, 7-swap and 0-pass, Wild Draw 10.' ),
		array( 'UNO Dare', 'Dare List categories, Dare and Wild Dare cards, penalties.' ),
		array( 'UNO All Wild', 'Every card is wild: Wild Skip Two, Forced Swap, Targeted Draw Two.' ),
		array( 'Classic UNO', 'Setup, calling UNO and the basics shared by every edition.' ),
	);
	$steps = array(
		array( 'Ask', 'Type a question in plain English, such as "How many points is a Wild Draw Color card worth?"' ),
		array( 'Search the rulebooks', 'The assistant searches the official rulebook PDFs with keyword and meaning-based search, narrowed to the edition you name.' ),
		array( 'Answer with sources', 'It answers only from the passages it found and shows which rulebook and page each answer comes from.' ),
	);
	$features = array(
		array( 'Cited answers', 'Every rules answer lists its source rulebook and page, so you can check it yourself.' ),
		array( 'Remembers the conversation', 'Follow-ups like "and in UNO Dare?" or "how many points is it worth?" are understood in context.' ),
		array( 'Stays on topic', 'Questions outside the UNO rulebooks get a polite "I can only help with UNO rules" instead of a made-up answer.' ),
		array( 'Honest about gaps', 'If the rulebooks do not cover something, it says so rather than guessing.' ),
	);
	$examples = array(
		'What does the Skip Everyone card do in UNO Flip?',
		'What is the Mercy rule in UNO No Mercy?',
		'How does stacking work in UNO No Mercy?',
		'What happens if I forget to call UNO?',
		'What does the Wild Forced Swap card do?',
	);
	$stack = array( 'LangGraph', 'FastAPI', 'ChromaDB', 'BM25 + vector search', 'Google Gemini (Vertex AI)', 'Langfuse', 'WordPress' );

	ob_start();
	?>
	<div class="uno-home alignfull">
		<section class="uno-home__hero">
			<div class="uno-home__hero-text">
				<p class="uno-home__eyebrow">UNO Rules Assistant</p>
				<h1 class="uno-home__title">Settle every UNO argument in seconds.</h1>
				<p class="uno-home__lead">
					An AI chatbot that reads the official UNO rulebooks for you. Ask about any card, rule or scoring detail
					in five editions and get a short answer with the rulebook and page it came from.
				</p>
				<div class="uno-home__actions">
					<a class="uno-home__btn uno-home__btn--primary" href="<?php echo esc_url( $chat_url ); ?>">Start chatting</a>
					<a class="uno-home__btn uno-home__btn--ghost" href="#uno-how">How it works</a>
				</div>
				<ul class="uno-home__stats">
					<li><strong>5</strong> rulebooks</li>
					<li><strong>Cited</strong> answers</li>
					<li><strong>Gemini</strong> AI models</li>
				</ul>
			</div>
		</section>

		<section class="uno-home__section">
			<h2>Rulebooks it knows</h2>
			<div class="uno-home__grid uno-home__grid--5">
				<?php foreach ( $rulebooks as $r ) : ?>
					<article class="uno-home__tile">
						<h3><?php echo esc_html( $r[0] ); ?></h3>
						<p><?php echo esc_html( $r[1] ); ?></p>
					</article>
				<?php endforeach; ?>
			</div>
		</section>

		<section class="uno-home__section" id="uno-how">
			<h2>How it works</h2>
			<ol class="uno-home__grid uno-home__grid--3 uno-home__steps">
				<?php foreach ( $steps as $i => $s ) : ?>
					<li class="uno-home__tile">
						<span class="uno-home__step-num"><?php echo esc_html( $i + 1 ); ?></span>
						<h3><?php echo esc_html( $s[0] ); ?></h3>
						<p><?php echo esc_html( $s[1] ); ?></p>
					</li>
				<?php endforeach; ?>
			</ol>
		</section>

		<section class="uno-home__section">
			<h2>What makes it useful</h2>
			<div class="uno-home__grid uno-home__grid--4">
				<?php foreach ( $features as $f ) : ?>
					<article class="uno-home__tile">
						<h3><?php echo esc_html( $f[0] ); ?></h3>
						<p><?php echo esc_html( $f[1] ); ?></p>
					</article>
				<?php endforeach; ?>
			</div>
		</section>

		<section class="uno-home__section uno-home__split">
			<div>
				<h2>Try asking</h2>
				<ul class="uno-home__examples">
					<?php foreach ( $examples as $q ) : ?>
						<li><a href="<?php echo esc_url( add_query_arg( 'ask', rawurlencode( $q ), $chat_url ) ); ?>"><?php echo esc_html( $q ); ?></a></li>
					<?php endforeach; ?>
				</ul>
			</div>
			<div>
				<h2>Under the hood</h2>
				<p>
					A retrieval-augmented generation (RAG) pipeline: the rulebook PDFs are split into passages and indexed,
					each question is matched against them, and a language model writes the answer from the best matches only.
				</p>
				<ul class="uno-home__chips">
					<?php foreach ( $stack as $t ) : ?>
						<li><?php echo esc_html( $t ); ?></li>
					<?php endforeach; ?>
				</ul>
				<p class="uno-home__note">
					Powered by Google Gemini. To keep things fair there is a limit on questions per visitor per hour.
					Answers usually take a few seconds.
				</p>
			</div>
		</section>

		<section class="uno-home__cta">
			<h2>Got a rules dispute at the table?</h2>
			<a class="uno-home__btn uno-home__btn--primary" href="<?php echo esc_url( $chat_url ); ?>">Ask the rulebook</a>
		</section>
	</div>
	<?php
	return ob_get_clean();
} );
