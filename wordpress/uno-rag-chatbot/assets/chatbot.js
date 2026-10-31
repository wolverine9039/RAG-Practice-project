/* UNO Rulebook RAG Chatbot widget. Talks only to the WordPress REST proxy (uno-chat/v1). */
(function () {
  "use strict";

  var CFG = window.UNO_CHAT || {};
  var SESSION_KEY = "uno_chat_session";

  // Static icons (constant markup, never built from user or model text)
  var ICON_SPARK =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 2c.4 3.9 2.1 6.6 6.5 7.6-4.4 1-6.1 3.7-6.5 7.6-.4-3.9-2.1-6.6-6.5-7.6C9.9 8.6 11.6 5.9 12 2Zm6.5 11.5c.2 1.8 1 3 3 3.5-2 .5-2.8 1.7-3 3.5-.2-1.8-1-3-3-3.5 2-.5 2.8-1.7 3-3.5Z"/></svg>';
  var ICON_SEND =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z"/></svg>';
  var ICON_CHAT =
    '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/></svg>';
  var ICON_UP =
    '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M2 21h3V9H2v12Zm19-11a2 2 0 0 0-2-2h-6.3l1-4.6v-.3c0-.4-.2-.8-.4-1.1L12.2 1 6.6 6.6C6.2 7 6 7.5 6 8v11a2 2 0 0 0 2 2h9c.8 0 1.5-.5 1.8-1.2l3-7.1c.1-.2.2-.5.2-.7v-2Z"/></svg>';
  var ICON_DOWN =
    '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M22 3h-3v12h3V3ZM3 14a2 2 0 0 0 2 2h6.3l-1 4.6v.3c0 .4.2.8.4 1.1l1.1 1 5.6-5.6c.4-.4.6-.9.6-1.4V5a2 2 0 0 0-2-2H7c-.8 0-1.5.5-1.8 1.2l-3 7.1c-.1.2-.2.5-.2.7v2Z"/></svg>';
  var ICON_CLOSE =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4L12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>';

  function newSessionId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function getSessionId() {
    var id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = newSessionId();
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text; // textContent: never inject HTML from answers
    return node;
  }

  function api(path, payload) {
    return fetch(CFG.restUrl + path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-WP-Nonce": CFG.nonce },
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.message || "Something went wrong. Please try again.");
        return data;
      });
    });
  }

  function mount(root) {
    var floating = root.getAttribute("data-floating") === "1";
    var busy = false;

    var panel = el("div", "uno-chat__panel");
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", CFG.title || "UNO Rules Assistant");

    // ---- header
    var header = el("div", "uno-chat__header");
    var avatar = el("span", "uno-chat__avatar");
    avatar.innerHTML = ICON_SPARK;
    var meta = el("div", "uno-chat__meta");
    meta.appendChild(el("span", "uno-chat__title", CFG.title || "UNO Rules Assistant"));
    var status = el("span", "uno-chat__status");
    status.appendChild(el("span", "uno-chat__dot"));
    status.appendChild(document.createTextNode(CFG.subtitle || "Answers from the UNO rulebooks"));
    meta.appendChild(status);
    var resetBtn = el("button", "uno-chat__reset", "New chat");
    resetBtn.type = "button";
    header.appendChild(avatar);
    header.appendChild(meta);
    header.appendChild(resetBtn);

    // ---- conversation
    var log = el("div", "uno-chat__log");
    log.setAttribute("aria-live", "polite");
    var suggestions = el("div", "uno-chat__suggestions");

    // ---- composer
    var form = el("form", "uno-chat__form");
    var input = el("input", "uno-chat__input");
    input.type = "text";
    input.placeholder = "Ask about any UNO rule…";
    input.maxLength = 1000;
    input.setAttribute("aria-label", "Your question");
    var send = el("button", "uno-chat__send");
    send.type = "submit";
    send.setAttribute("aria-label", "Send");
    send.innerHTML = ICON_SEND;
    form.appendChild(input);
    form.appendChild(send);
    var foot = el("p", "uno-chat__foot", "Answers come only from the official rulebooks.");

    panel.appendChild(header);
    panel.appendChild(log);
    panel.appendChild(suggestions);
    panel.appendChild(form);
    panel.appendChild(foot);

    if (floating) {
      var bubble = el("button", "uno-chat__bubble");
      bubble.type = "button";
      bubble.setAttribute("aria-label", "Open chat");
      bubble.setAttribute("aria-expanded", "false");
      bubble.innerHTML = ICON_CHAT;
      root.appendChild(bubble);
      root.classList.add("is-closed");
      bubble.addEventListener("click", function () {
        var open = root.classList.toggle("is-closed") === false;
        bubble.innerHTML = open ? ICON_CLOSE : ICON_CHAT;
        bubble.setAttribute("aria-label", open ? "Close chat" : "Open chat");
        bubble.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) input.focus();
      });
    }
    root.appendChild(panel);

    function scrollDown() {
      log.scrollTop = log.scrollHeight;
    }

    function addRow(who) {
      var row = el("div", "uno-chat__row uno-chat__row--" + who);
      var bubbleEl = el("div", "uno-chat__bubble-msg");
      row.appendChild(bubbleEl);
      log.appendChild(row);
      scrollDown();
      return { row: row, bubble: bubbleEl };
    }

    function addText(who, text) {
      var r = addRow(who);
      r.bubble.textContent = text;
      return r;
    }

    function addTyping() {
      var r = addRow("bot");
      r.bubble.classList.add("is-typing");
      r.bubble.setAttribute("aria-label", "Thinking");
      for (var i = 0; i < 3; i++) r.bubble.appendChild(el("span", "uno-chat__typing-dot"));
      return r;
    }

    function renderSources(row, sources) {
      if (!sources || !sources.length) return;
      var wrap = el("div", "uno-chat__sources");
      wrap.appendChild(el("span", "uno-chat__sources-label", "Sources"));
      sources.forEach(function (s) {
        wrap.appendChild(el("span", "uno-chat__chip", s.page ? s.source + " · p." + s.page : s.source));
      });
      row.appendChild(wrap);
    }

    function renderFeedback(row, traceId) {
      if (!traceId) return; // monitoring off: no rating buttons
      var wrap = el("div", "uno-chat__feedback");
      var label = el("span", "uno-chat__feedback-label", "Helpful?");
      wrap.appendChild(label);
      var buttons = [];
      [[1, ICON_UP, "Helpful"], [-1, ICON_DOWN, "Not helpful"]].forEach(function (spec) {
        var b = el("button", "uno-chat__vote");
        b.type = "button";
        b.innerHTML = spec[1];
        b.setAttribute("aria-label", spec[2]);
        b.title = spec[2];
        b.addEventListener("click", function () {
          buttons.forEach(function (x) { x.disabled = true; });
          b.classList.add("is-selected");
          api("feedback", { trace_id: traceId, value: spec[0] })
            .then(function () {
              label.textContent = "Thanks for the feedback!";
              wrap.classList.add("is-done");
            })
            .catch(function () {
              // quietly allow another try
              b.classList.remove("is-selected");
              buttons.forEach(function (x) { x.disabled = false; });
            });
        });
        buttons.push(b);
        wrap.appendChild(b);
      });
      row.appendChild(wrap);
    }

    function showSuggestions(show) {
      suggestions.innerHTML = "";
      if (!show || !CFG.suggestions || !CFG.suggestions.length) return;
      CFG.suggestions.forEach(function (q) {
        var b = el("button", "uno-chat__suggestion", q);
        b.type = "button";
        b.addEventListener("click", function () { ask(q); });
        suggestions.appendChild(b);
      });
    }

    function welcome() {
      log.innerHTML = "";
      addText("bot", CFG.welcome || "Hi! Ask me anything about the UNO rulebooks.");
      showSuggestions(true);
    }

    function ask(question) {
      question = (question || "").trim();
      if (!question || busy) return;
      busy = true;
      showSuggestions(false);
      addText("user", question);
      input.value = "";
      send.disabled = true;
      var pending = addTyping();

      api("ask", { question: question, session_id: getSessionId() })
        .then(function (data) {
          pending.bubble.classList.remove("is-typing");
          pending.bubble.removeAttribute("aria-label");
          pending.bubble.textContent = data.answer;
          renderSources(pending.row, data.sources);
          renderFeedback(pending.row, data.trace_id);
        })
        .catch(function (err) {
          pending.bubble.classList.remove("is-typing");
          pending.bubble.classList.add("is-error");
          pending.bubble.textContent = err.message;
        })
        .then(function () {
          busy = false;
          send.disabled = false;
          input.focus();
          scrollDown();
        });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      ask(input.value);
    });

    resetBtn.addEventListener("click", function () {
      var old = getSessionId();
      localStorage.setItem(SESSION_KEY, newSessionId());
      api("reset", { session_id: old }).catch(function () {});
      welcome();
    });

    welcome();

    // Example links on the home page open the chat with ?ask=...: pre-fill (not auto-send) the inline box
    if (!floating && window.URLSearchParams) {
      var prefill = new URLSearchParams(window.location.search).get("ask");
      if (prefill) {
        input.value = prefill.slice(0, 1000);
        input.focus();
      }
    }
  }

  function init() {
    var roots = document.querySelectorAll("[data-uno-chat]");
    for (var i = 0; i < roots.length; i++) {
      if (!roots[i].hasAttribute("data-uno-ready")) {
        roots[i].setAttribute("data-uno-ready", "1");
        mount(roots[i]);
      }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
