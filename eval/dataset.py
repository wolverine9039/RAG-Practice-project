"""Hand-labelled evaluation set, written against the extracted rulebook text.

answer: list of groups; every group must match, a group matches if ANY of its
        alternatives appears in the answer (case-insensitive, word-bounded for numbers).
evidence: substring that the "gold" chunk contains (used for context-recall).
"""

DARE = "Uno Dare.pdf"
MERCY = "Uno No mercy.pdf"
FLIP = "uno flip.pdf"
WILD = "uno-all-wild-rules-pdf-unoallwild.com_.pdf"

RAG_QUESTIONS = [
    # ---- UNO Dare
    {"q": "How many cards are in the UNO Dare deck?", "sources": [DARE], "evidence": "108 cards", "answer": [["108"]]},
    {"q": "What are the Dare List categories in UNO Dare?", "sources": [DARE], "evidence": "daredevil", "answer": [["family"], ["showoff", "show off"], ["daredevil"]]},
    {"q": "What happens when a Dare card is played in UNO Dare?", "sources": [DARE], "evidence": "do the dare associated", "answer": [["draw 2", "draw two", "2 cards", "two cards"], ["dare"]]},
    {"q": "How many points is a Wild Dare card worth in UNO Dare?", "sources": [DARE], "evidence": "wild dare . .", "answer": [["50"]]},
    {"q": "What happens if a player fails a dare in UNO Dare?", "sources": [DARE], "evidence": "suffer a penalty", "answer": [["draw 2", "draw two", "2 cards", "two cards"]]},
    {"q": "How many points do you need to win UNO Dare?", "sources": [DARE], "evidence": "first player to reach 500", "answer": [["500"]]},
    # ---- UNO No Mercy
    {"q": "How many cards are in UNO No Mercy?", "sources": [MERCY], "evidence": "168 cards", "answer": [["168"]]},
    {"q": "What is the Mercy rule in UNO No Mercy?", "sources": [MERCY], "evidence": "25 or more cards", "answer": [["25"]]},
    {"q": "How does stacking work in UNO No Mercy?", "sources": [MERCY], "evidence": "stack", "answer": [["draw card", "draw cards", "+2", "+4", "+6", "+10"], ["higher"]]},
    {"q": "What happens when you play a 7 in UNO No Mercy?", "sources": [MERCY], "evidence": "swap your", "answer": [["swap", "exchange"]]},
    {"q": "What happens when a 0 is played in UNO No Mercy?", "sources": [MERCY], "evidence": "pass their hand", "answer": [["pass"]]},
    {"q": "What does the Wild Color Roulette card do?", "sources": [MERCY], "evidence": "color roulette card - the next player", "answer": [["color", "colour"], ["reveal", "draw"]]},
    {"q": "How many points do you get for knocking out a player in UNO No Mercy?", "sources": [MERCY], "evidence": "250 points", "answer": [["250"]]},
    {"q": "How many points are needed to win UNO No Mercy when keeping score?", "sources": [MERCY], "evidence": "1000 points", "answer": [["1000", "1,000"]]},
    {"q": "What does the Discard All card do in UNO No Mercy?", "sources": [MERCY], "evidence": "discard all the cards", "answer": [["discard"], ["color", "colour"]]},
    # ---- UNO Flip
    {"q": "How many cards are in UNO Flip?", "sources": [FLIP], "evidence": "112 cards as follows", "answer": [["112"]]},
    {"q": "What does the Flip card do in UNO Flip?", "sources": [FLIP], "evidence": "everything flips", "answer": [["dark"], ["light"]]},
    {"q": "What does the Draw Five card do in UNO Flip?", "sources": [FLIP], "evidence": "draw five cards", "answer": [["five", "5"]]},
    {"q": "What does the Skip Everyone card do in UNO Flip?", "sources": [FLIP], "evidence": "skip everyone card", "answer": [["skip", "skipped"], ["all", "every"]]},
    {"q": "How many points is the Wild Draw Color card worth in UNO Flip?", "sources": [FLIP], "evidence": "60 points", "answer": [["60"]]},
    {"q": "In UNO Flip, what happens if you challenge a Wild Draw 2 and the player is innocent?", "sources": [FLIP], "evidence": "(4 total)", "answer": [["4", "four"]]},
    {"q": "What colors are on the dark side of UNO Flip?", "sources": [FLIP], "evidence": "18 pink cards", "answer": [["pink"], ["teal"], ["orange"], ["purple"]]},
    {"q": "How many points is the Skip Everyone card worth in UNO Flip?", "sources": [FLIP], "evidence": "30 points", "answer": [["30"]]},
    # ---- UNO All Wild
    {"q": "How many cards are dealt to each player in UNO All Wild?", "sources": [WILD], "evidence": "deal 7 cards", "answer": [["7", "seven"]]},
    {"q": "What does the Wild Skip Two card do in UNO All Wild?", "sources": [WILD], "evidence": "next two players lose", "answer": [["two", "2"], ["lose", "skip"]]},
    {"q": "What does the Wild Forced Swap card do?", "sources": [WILD], "evidence": "exchange hands", "answer": [["swap", "exchange"], ["hand"]]},
    {"q": "What does the Wild Targeted Draw Two card do?", "sources": [WILD], "evidence": "a player of your choice draws 2", "answer": [["choice", "choose", "choosing", "pick"], ["2", "two"]]},
    {"q": "In UNO All Wild, do you need to match the color or number?", "sources": [WILD], "evidence": "every card is wild", "answer": [["every card is wild", "all cards are wild", "every card in the game is wild", "don't need", "do not need", "don’t need", "no need", "not need", "any card"]]},
    {"q": "How many points do you need to win UNO All Wild?", "sources": [WILD], "evidence": "reaches 500 points", "answer": [["500"]]},
    # ---- no rulebook named
    {"q": "What is the penalty for forgetting to call UNO?", "sources": [DARE, MERCY, FLIP, WILD], "evidence": "draw 2 cards|draw two cards", "answer": [["2", "two"]]},
    {"q": "Which card makes the next player draw until they get a chosen color?", "sources": [FLIP, MERCY], "evidence": "until they get", "answer": [["wild draw color", "color roulette"]]},
]

OFF_TOPIC = [
    "What is the capital of France?",
    "Who won the 2018 FIFA World Cup?",
    "Write a Python function to reverse a string.",
    "How do I bake a chocolate cake?",
    "How does castling work in chess?",
    "What is the boiling point of water?",
]

CHITCHAT = [
    "hi", "hello there", "hey!", "good morning", "how are you?", "how's it going?",
    "thanks!", "thank you so much", "bye", "see you later", "who are you?",
    "what can you do?", "what is your name?", "nice to meet you", "ok cool", "you're awesome",
]

# Messages that must NOT be treated as chit-chat
ROUTER_RAG_EXTRA = [
    "and in Dare?", "what about No Mercy?", "how many points is it worth?",
    "hi, how many cards are dealt in UNO Flip?", "thanks, and what does the Skip card do?",
]

FOLLOW_UPS = [
    {"turns": ["What does the Skip Everyone card do in UNO Flip?", "How many points is it worth?"], "sources": [FLIP], "answer": [["30"]]},
    {"turns": ["How many cards are dealt in UNO No Mercy?", "Is it the same in UNO Dare?"], "sources": [DARE], "answer": [["7", "seven"]]},
    {"turns": ["What is the Mercy rule in UNO No Mercy?", "How many points do you get for knocking someone out?"], "sources": [MERCY], "answer": [["250"]]},
    {"turns": ["What does the Wild Draw Color card do in UNO Flip?", "What happens if I challenge it and the player was innocent?"], "sources": [FLIP], "answer": [["2", "two"]]},
]
