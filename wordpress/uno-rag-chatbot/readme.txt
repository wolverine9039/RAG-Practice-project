=== UNO Rulebook RAG Chatbot ===
Contributors: mayankbisht
Requires at least: 6.0
Requires PHP: 7.4
Stable tag: 1.6.0
License: GPLv2 or later

Chat widget that answers questions about the UNO rulebooks using a FastAPI + LangGraph RAG backend (Google Gemini on Vertex AI).

== Description ==

* Shortcode [uno_chatbot] renders an inline chat box on any page or post.
* Shortcode [uno_chatbot_home] renders the landing page (what the chatbot does, rulebooks covered, how it works,
  example questions).
* Optional floating chat bubble on every page.
* The browser only talks to WordPress (/wp-json/uno-chat/v1/ask). WordPress forwards the question to the
  FastAPI backend server-side, so the backend URL and API key are never exposed.
* Per-visitor hourly limit (default 30) and a site-wide daily question cap (default 300) protect the Google Cloud
  credits behind the backend. Both are set under Settings > UNO Chatbot; the daily counter is stored in the database.
* Thumbs up/down under each answer when the backend has Langfuse monitoring enabled (stored as a
  user-feedback score). Visitors are identified only by a salted hash of their IP.

== Installation ==

1. Upload the plugin zip via Plugins > Add New > Upload Plugin, then activate it.
2. Go to Settings > UNO Chatbot:
   * Backend URL: where the FastAPI server runs (e.g. https://api.example.com, or
     http://host.docker.internal:8000 when WordPress runs in Docker on the same PC).
   * Backend API key: the BACKEND_API_KEY value from the backend .env file.
3. Add [uno_chatbot] to a page, or tick "Floating chat bubble".

The settings page shows whether the backend is reachable and how many requests were used today.

== Notes ==

* If your site uses full-page caching, exclude the chat page or the REST nonce may expire (403 "Your session expired").
* The backend must be reachable from the WordPress server (not necessarily from visitors' browsers).
* Behind a reverse proxy, make sure REMOTE_ADDR is the real visitor IP (the Google Cloud setup sets it from the
  proxy's X-Real-IP header), otherwise all visitors share one rate-limit bucket.

== Changelog ==

= 1.6.0 =
* Removed the unused ThreeUI holo card shortcode and assets.

= 1.5.0 =
* Site-wide daily question cap.
