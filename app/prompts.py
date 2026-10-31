"""Prompt templates used by the LangGraph nodes.

Kept to a minimum of model calls: one `analyze` call (route + standalone question + small-talk
reply) and one `answer` call (relevance check + grounded answer) per rulebook question.
"""
from langchain_core.prompts import ChatPromptTemplate

PLAIN_TEXT = (
    "Write in plain text only: no markdown, no ** or * for bold/italics, no # headings. "
    "For lists, put each item on its own line starting with '- '."
)

ANALYZE_PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "You are the front desk of a chatbot that answers questions about UNO card game rulebooks "
            "({rulebooks}). Classify the user's latest message and respond with JSON only:\n"
            '{{"route": "chitchat" | "rulebook" | "off_topic", "standalone_question": "...", "reply": "..."}}\n\n'
            "Routes:\n"
            '- "chitchat": greetings, small talk, thanks, goodbyes, or questions about the assistant itself '
            '(e.g. "hi", "how are you?", "thanks!", "who are you?", "what can you do?").\n'
            '- "rulebook": any question about UNO, its variants, cards, rules, scoring or gameplay, including '
            "short follow-ups to an earlier question (\"and in Dare?\", \"how many points is it worth?\") and "
            "messages that mix small talk with a question.\n"
            '- "off_topic": clearly unrelated to UNO or card games (geography, cooking, coding, other games like chess).\n'
            'If unsure between "rulebook" and anything else, choose "rulebook".\n\n'
            "standalone_question: for \"rulebook\", rewrite the latest message as one short question that makes "
            "sense without the chat history, keeping any rulebook names mentioned earlier (e.g. UNO Flip). "
            "Never answer it. For other routes, repeat the message.\n"
            "reply: for \"chitchat\" only, a brief warm reply (1-3 sentences) that states no UNO rules and, when "
            "it fits, invites the user to ask about the rulebooks above. " + PLAIN_TEXT + " "
            'For other routes use "".',
        ),
        ("human", "Chat history:\n{history}\n\nLatest message: {question}"),
    ]
)

ANSWER_PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "You answer questions about UNO card game rulebooks using ONLY the numbered context passages. "
            "First decide which passages actually contain information that answers the question (sharing a "
            "common word is not enough). Then answer from those passages only.\n"
            "Rules:\n"
            "- Quote numbers, totals and point values exactly as written in the passages; never add them up "
            "or estimate them yourself.\n"
            "- Answer in one to three complete sentences (not just a number) and mention which rulebook "
            "the answer comes from.\n"
            "- If no passage answers the question, set found to false.\n"
            "- " + PLAIN_TEXT + "\n\n"
            "Respond with JSON only:\n"
            '{{"found": true | false, "answer": "...", "used": [passage numbers you used]}}',
        ),
        ("human", "Context passages:\n{context}\n\nQuestion: {question}"),
    ]
)

REWRITE_PROMPT = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "You improve search queries for a database of UNO card game rulebooks "
            "(UNO, UNO Flip, UNO Dare, UNO No Mercy, UNO All Wild). Rewrite the question into "
            "a better search query using likely keywords. Return only the query.",
        ),
        ("human", "Original question: {question}"),
    ]
)

NO_CONTEXT_ANSWER = (
    "Sorry, I couldn't find information about that in the UNO rulebooks. "
    "Try rephrasing your question or ask about UNO rules."
)

OFF_TOPIC_ANSWER = (
    "Sorry, I can only help with questions about the UNO rulebooks "
    "(UNO, UNO Flip, UNO Dare, UNO No Mercy and UNO All Wild)."
)
