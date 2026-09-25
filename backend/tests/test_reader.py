from smartbook.classics import CLASSICS, TEXTS_DIR, attach_classics, clean_gutenberg

CHAPTER = "\n\n".join(f"Paragraph {i}. The keeper climbed the stairs and lit the great lamp once more." for i in range(80))


def add(client, book):
    r = client.post("/api/books", json=book)
    assert r.status_code == 201
    return r.json()


def test_book_without_text_has_empty_content(client, books):
    book = add(client, books[1])
    assert book["text_chars"] == 0
    content = client.get(f"/api/books/{book['id']}/content").json()
    assert content["text"] == "" and content["progress"] is None
    assert client.get("/api/books/nope/content").status_code == 404


def test_progress_is_saved_and_furthest_page_only_grows(client, books):
    book = add(client, dict(books[0], text=CHAPTER))
    url = f"/api/books/{book['id']}/progress"
    first = client.put(url, json={"offset": 2000, "page": 3, "pages": 12}).json()
    assert (first["page"], first["pages"], first["furthest_page"]) == (3, 12, 3)
    assert 0 < first["percent"] < 100
    back = client.put(url, json={"offset": 0, "page": 1, "pages": None}).json()
    assert (back["page"], back["pages"], back["furthest_page"], back["percent"]) == (1, 12, 3, 0.0)

    listed = {b["id"]: b for b in client.get("/api/books").json()}
    assert listed[book["id"]]["progress"]["furthest_page"] == 3
    assert client.get(f"/api/books/{book['id']}/content").json()["progress"]["char_offset"] == 0


def test_progress_validation(client, books):
    book = add(client, dict(books[0], text=CHAPTER))
    url = f"/api/books/{book['id']}/progress"
    assert client.put(url, json={"offset": 10}).status_code == 400
    assert client.put(url, json={"offset": -1, "page": 1}).status_code == 400
    assert client.put(url, json={"offset": 0, "page": 5, "pages": 2}).status_code == 400
    assert client.put(url, json={"offset": 10 ** 9, "page": 1}).status_code == 400
    assert client.put("/api/books/nope/progress", json={"offset": 0, "page": 1}).status_code == 404


def test_attach_text_reindexes_and_resets_progress(client, books):
    book = add(client, books[0])
    client.put(f"/api/books/{book['id']}/progress", json={"offset": 0, "page": 1})
    r = client.post(f"/api/books/{book['id']}/text", files={"file": ("walden.txt", CHAPTER.encode())})
    assert r.status_code == 200
    updated = r.json()
    assert updated["text_chars"] == len(CHAPTER) and updated["chunks"] > 1 and updated["progress"] is None
    assert client.get(f"/api/books/{book['id']}/content").json()["text"] == CHAPTER
    assert client.app.state.services.library.col.count() == updated["chunks"]

    assert client.post(f"/api/books/{book['id']}/text", files={"file": ("x.txt", b"too short")}).status_code == 422
    assert client.post("/api/books/nope/text", files={"file": ("x.txt", CHAPTER.encode())}).status_code == 404


def test_deleting_a_book_drops_its_progress(client, services, books):
    book = add(client, dict(books[0], text=CHAPTER))
    client.put(f"/api/books/{book['id']}/progress", json={"offset": 0, "page": 1})
    assert book["id"] in services.store.progress_map()
    client.delete(f"/api/books/{book['id']}")
    assert book["id"] not in services.store.progress_map()  # ON DELETE CASCADE


def test_classic_texts_ship_with_the_app_and_attach_once(services):
    assert all((TEXTS_DIR / name).is_file() for _, name in CLASSICS.values())
    services.store.insert_book({"title": "Walden", "author": "Henry David Thoreau", "description": "d",
                                "genres": [], "themes": []}, chunks=1)
    assert attach_classics(services.store) == 1
    walden = services.store.find_book_exact("walden")
    assert walden["text_chars"] > 500_000
    assert services.store.get_text(walden["id"]).rstrip().endswith("THE END")  # Civil Disobedience trimmed off
    assert attach_classics(services.store) == 0  # never overwrites existing text


def test_clean_gutenberg():
    raw = ("Header\r\n*** START OF THE PROJECT GUTENBERG EBOOK X ***\r\n\r\nIt was _very_ cold on the 21_st_.\r\n"
           "[Illustration: a pond]\r\n\r\n\r\n\r\nEnd.\r\n*** END OF THE PROJECT GUTENBERG EBOOK X ***\r\nLicence")
    assert clean_gutenberg(raw, "X") == "It was very cold on the 21st.\n\nEnd."


def test_reading_text_joins_prose_and_keeps_short_lines():
    from smartbook.importers import reading_text

    prose = "It is a truth universally acknowledged, that a single man in possession\nof a good fortune, must be in want."
    toc = "Contents\n  Economy\n  Solitude\n  The Ponds"
    expected = prose.replace("\n", " ") + "\n\nContents\nEconomy\nSolitude\nThe Ponds"
    assert reading_text(f"{prose}\n\n\n{toc}\r\n") == expected
    assert reading_text(expected) == expected  # idempotent
