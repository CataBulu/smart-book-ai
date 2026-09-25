import pytest

from smartbook.rewrite import build_prompt, clean, needs_rewrite

HISTORY = [
    {"role": "user", "content": "Books about solitude and deep focus"},
    {"role": "assistant", "content": "**Walden** by Henry David Thoreau — ..."},
]


@pytest.mark.parametrize("message", [
    "something darker?",
    "more like that",
    "What about the second one?",
    "Is it long?",
    "by a female author",
    "shorter please",
    "why?",
    "Tell me more about the first one",
])
def test_follow_ups_are_rewritten(message):
    assert needs_rewrite(message, HISTORY)


@pytest.mark.parametrize("message", [
    "Books that make me cry about friendship",
    "Science fiction novels about artificial intelligence",
    "Recommend a gothic mystery set in England",
])
def test_standalone_messages_are_not_rewritten(message):
    assert not needs_rewrite(message, HISTORY)


def test_no_history_means_no_rewrite():
    assert not needs_rewrite("more like that", [])


def test_prompt_contains_history_and_follow_up():
    messages = build_prompt("something darker?", HISTORY)
    assert messages[0]["role"] == "system"
    assert "User: Books about solitude and deep focus" in messages[1]["content"]
    assert "Follow-up: something darker?" in messages[1]["content"]


@pytest.mark.parametrize("output, expected", [
    ('"dark literary novels about solitude"', "dark literary novels about solitude"),
    ("Standalone query: gothic mysteries\nExplanation: ...", "gothic mysteries"),
    ("   \n  ", "fallback"),
])
def test_clean(output, expected):
    assert clean(output, "fallback") == expected
