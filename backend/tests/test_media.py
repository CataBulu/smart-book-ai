import io
import wave

from smartbook.media import cover_prompt, scene_prompt, speakable, tiny_png


def add_book(client, books, i=0):
    r = client.post("/api/books", json=books[i])
    assert r.status_code == 201
    return r.json()


def test_health_reports_media(client):
    assert client.get("/api/health").json()["media"] == {"images": True, "tts": True, "stt": True}


def test_generate_cover_persists_and_replaces(client, books):
    book = add_book(client, books)
    assert book["cover_url"] is None
    first = client.post(f"/api/books/{book['id']}/cover").json()["cover_url"]
    assert first.startswith("/api/media/covers/")
    img = client.get(first)
    assert img.status_code == 200 and img.content == tiny_png()

    second = client.post(f"/api/books/{book['id']}/cover").json()["cover_url"]
    assert second != first
    assert client.get(first).status_code == 404  # old cover file removed
    assert client.get("/api/books").json()[0]["cover_url"] == second

    client.delete(f"/api/books/{book['id']}")
    assert client.get(second).status_code == 404  # cover removed with the book


def test_cover_shows_up_in_chat_sources(client, books):
    book = add_book(client, books)
    url = client.post(f"/api/books/{book['id']}/cover").json()["cover_url"]
    r = client.post("/api/chat", json={"message": "solitude nature cabin pond"})
    assert f'"cover_url": "{url}"' in r.text


def test_illustrate(client, books):
    book = add_book(client, books, 1)
    r = client.post(f"/api/books/{book['id']}/illustrate")
    assert r.status_code == 201
    assert r.json()["caption"] == "A scene inspired by Dune"
    assert client.get(r.json()["url"]).status_code == 200
    assert client.post("/api/books/nope/illustrate").status_code == 404


def test_image_prompt_passes_moderation(client):
    r = client.post("/api/books", json={"title": "Bad", "author": "X",
                                        "description": "How to make a pipe bomb at home, step by step."})
    assert client.post(f"/api/books/{r.json()['id']}/cover").status_code == 422


def test_media_path_traversal_is_rejected(client):
    assert client.get("/api/media/covers/..%2Fsmartbook.db").status_code == 404
    assert client.get("/api/media/secret/x.png").status_code == 404


def test_tts_returns_wav(client):
    r = client.post("/api/tts", json={"text": "**Stoner** by John Williams", "voice": "bf_emma"})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(r.content)) as w:
        assert w.getnframes() > 0
    assert client.post("/api/tts", json={"text": "  "}).status_code == 400
    assert [v["id"] for v in client.get("/api/voices").json()][0] == "af_heart"


def test_stt(client):
    r = client.post("/api/stt", files={"audio": ("clip.webm", b"\x1a\x45\xdf\xa3fake", "audio/webm")})
    assert r.json() == {"text": "books about the sea"}
    assert client.post("/api/stt", files={"audio": ("clip.webm", b"", "audio/webm")}).status_code == 400
    assert client.post("/api/stt", data={"x": "1"}).status_code == 400


def test_prompts_and_speakable(books):
    p = cover_prompt(books[0])
    assert "non-fiction book about solitude, nature" in p and p.endswith("no text")
    assert "Living alone in a cabin" in scene_prompt(books[0])
    assert speakable("## Picks\n- **Walden** by [Thoreau](http://x)\n> quote") == "Picks Walden by Thoreau quote"
