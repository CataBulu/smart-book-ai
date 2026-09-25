import json

import pytest
from starlette.testclient import TestClient

from smartbook.app import build_services, create_app
from smartbook.config import load_settings


@pytest.fixture
def settings(tmp_path, monkeypatch):
    monkeypatch.setenv("SMARTBOOK_FAKE_LLM", "1")
    monkeypatch.setenv("SMARTBOOK_AUTOSEED", "0")
    monkeypatch.setenv("SMARTBOOK_DATA_DIR", str(tmp_path / "data"))
    # Hashed bag-of-words vectors are far sparser than real embeddings, so the fake needs a looser threshold.
    monkeypatch.setenv("SMARTBOOK_RELEVANCE_MAX_DISTANCE", "0.9")
    return load_settings()


@pytest.fixture
def services(settings):
    return build_services(settings)


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings), headers={"X-Session-Id": "test-session"}) as c:
        yield c


BOOKS = [
    {"title": "Walden", "author": "Henry David Thoreau", "genres": ["Non-fiction"], "themes": ["solitude", "nature"],
     "description": "Living alone in a cabin by a pond, solitude and nature and simple living."},
    {"title": "Dune", "author": "Frank Herbert", "genres": ["Science Fiction"], "themes": ["desert", "empire"],
     "description": "Desert planet spice empire politics and prophecy."},
    {"title": "Rebecca", "author": "Daphne du Maurier", "genres": ["Gothic", "Mystery"], "themes": ["jealousy"],
     "description": "Gothic mystery of jealousy at the Manderley estate."},
]


@pytest.fixture
def books():
    return [dict(b) for b in BOOKS]


def sse_events(body: str) -> list[tuple[str, dict]]:
    events = []
    for block in body.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "event" in lines:
            events.append((lines["event"], json.loads(lines["data"])))
    return events
