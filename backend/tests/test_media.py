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


def picture(fmt="PNG", size=(1600, 2400), mode="RGB"):
    from PIL import Image
    out = io.BytesIO()
    Image.new(mode, size, (30, 80, 140) if mode == "RGB" else (30, 80, 140, 0)).save(out, fmt)
    return out.getvalue()


def test_upload_own_cover(client, books):
    from PIL import Image
    book = add_book(client, books)
    painted = client.post(f"/api/books/{book['id']}/cover").json()["cover_url"]

    r = client.put(f"/api/books/{book['id']}/cover", files={"file": ("mine.jpg", picture("JPEG"), "image/jpeg")})
    assert r.status_code == 200, r.text
    url = r.json()["cover_url"]
    assert url.endswith(".webp") and url != painted
    assert client.get(painted).status_code == 404  # the painted cover it replaced is gone
    served = Image.open(io.BytesIO(client.get(url).content))
    assert served.format == "WEBP" and served.size == (683, 1024)  # re-encoded and shrunk, aspect kept

    see_through = client.put(f"/api/books/{book['id']}/cover",
                             files={"file": ("logo.png", picture("PNG", (64, 64), "RGBA"), "image/png")})
    assert Image.open(io.BytesIO(client.get(see_through.json()["cover_url"]).content)).mode == "RGB"


def test_upload_cover_rejects_non_pictures(client, books):
    book = add_book(client, books)
    bad = client.put(f"/api/books/{book['id']}/cover", files={"file": ("cover.png", b"<svg>not a png</svg>", "image/png")})
    assert bad.status_code == 422 and "JPEG, PNG or WebP" in bad.json()["error"]
    assert client.get("/api/books").json()[0]["cover_url"] is None
    assert client.put(f"/api/books/{book['id']}/cover").status_code == 400  # no file sent
    assert client.put("/api/books/nope/cover", files={"file": ("a.png", picture(), "image/png")}).status_code == 404


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


def test_hardware_status_and_image_device_switch(client, settings):
    status = client.get("/api/hardware").json()
    assert {"gpu", "ram", "ollama", "images", "placement"} <= status.keys()
    assert status["ram"]["total_gb"] > 0 and status["placement"]["voice"] == "cpu"
    assert status["images"]["setting"] == "gpu"
    assert client.post("/api/hardware", json={"images": "cpu"}).json()["images"]["setting"] == "cpu"
    assert (settings.data_dir / "hardware.json").read_text() == '{"images": "cpu"}'
    assert client.post("/api/hardware", json={"images": "tpu"}).status_code == 400
