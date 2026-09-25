"""Conversation-aware follow-up rewriting: turn "something darker?" into a standalone library query."""

import re

# A message needs rewriting when it leans on earlier turns: pronouns/anaphora, continuation openers,
# bare comparatives, or it is too short to stand alone.
FOLLOW_UP = re.compile(
    r"\b(it|its|those|these|them|they|he|she|his|her|ones|another|else|similar|same|other|"
    r"first|second|third|last|previous|above|former|latter|(that|this|the)\s+one|like\s+(that|this|it|those))\b"
    r"|^\s*(and|also|but|or|what\s+about|how\s+about|any|anything|something|by|from|with|without|in|only|just|"
    r"maybe|ok|okay|yes|yeah|no|nope|sure|not)\b"
    r"|\b(shorter|longer|darker|lighter|happier|sadder|funnier|easier|harder|newer|older|less|fewer)\b",
    re.I,
)

SYSTEM = ("You rewrite a user's follow-up message into ONE standalone search query for a book library. "
          "Resolve pronouns and references using the conversation. Describe the qualities the user now wants "
          "(genre, fiction or non-fiction, mood, themes, length, setting). Do not copy titles the assistant already "
          "recommended unless the user asks about one specific book. "
          "Output only the query, in English, at most 25 words. No quotes, no explanations.")


def needs_rewrite(message: str, history: list[dict]) -> bool:
    if not any(m["role"] == "user" for m in history):
        return False
    return len(message.split()) <= 3 or bool(FOLLOW_UP.search(message))


def build_prompt(message: str, history: list[dict]) -> list[dict]:
    lines = []
    for m in history[-6:]:
        text = " ".join(m["content"].split())
        lines.append(f"{'User' if m['role'] == 'user' else 'Assistant'}: {text[:400]}")
    user = "Conversation:\n" + "\n".join(lines) + f"\n\nFollow-up: {message}\n\nStandalone query:"
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]


def clean(output: str, fallback: str) -> str:
    lines = [ln.strip() for ln in output.strip().splitlines() if ln.strip()]
    query = lines[0] if lines else ""
    query = re.sub(r"^(standalone\s+)?query\s*:\s*", "", query, flags=re.I).strip().strip('"\'`').strip()
    return " ".join(query.split()[:40]) or fallback
