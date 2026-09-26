import smartbook.library as library_module

TEXT = "\n\n".join(f"Paragraph {i}. Holmes walked through the fog towards the house on the moor." for i in range(120))


def add(client, **book):
    r = client.post("/api/books", json={"author": "Arthur Conan Doyle", "description": "d", **book})
    assert r.status_code == 201, r.text
    return r.json()


def test_series_fields_on_add_and_in_listing(client):
    b = add(client, title="The Hound of the Baskervilles", series="Sherlock Holmes", series_number="3")
    assert (b["series"], b["series_index"]) == ("Sherlock Holmes", 3.0)
    plain = add(client, title="Standalone", series_index=4)  # a number without a series is dropped
    assert (plain["series"], plain["series_index"]) == (None, None)
    listed = {x["title"]: x for x in client.get("/api/books").json()}
    assert listed["The Hound of the Baskervilles"]["series"] == "Sherlock Holmes"


def test_edit_details_reembeds_only_the_summary(client, services):
    b = add(client, title="A Study in Scarlet", text=TEXT)
    client.put(f"/api/books/{b['id']}/progress", json={"offset": 100, "page": 2, "pages": 9})
    r = client.patch(f"/api/books/{b['id']}", json={
        "description": "Sherlock Holmes, a consulting detective, takes his first case with Dr Watson.",
        "genres": "Mystery, Classic", "themes": ["deduction", "friendship"],
        "series": "Sherlock Holmes", "series_index": 1})
    assert r.status_code == 200, r.text
    edited = r.json()
    assert edited["genres"] == ["Mystery", "Classic"] and edited["series_index"] == 1.0
    assert edited["chunks"] == b["chunks"] and edited["progress"]["page"] == 2  # text + reading position untouched
    summary = client.app.state.services.library.col.get(ids=[f"{b['id']}:0"])["documents"][0]
    assert "Series: Sherlock Holmes, book 1." in summary and "consulting detective" in summary

    cleared = client.patch(f"/api/books/{b['id']}", json={"series": ""}).json()
    assert (cleared["series"], cleared["series_index"]) == (None, None)


def test_edit_validation(client):
    a = add(client, title="The Sign of the Four")
    add(client, title="The Valley of Fear")
    assert client.patch(f"/api/books/{a['id']}", json={"title": "  "}).status_code == 400
    assert client.patch(f"/api/books/{a['id']}", json={"title": "The Valley of Fear"}).status_code == 409
    assert client.patch("/api/books/nope", json={"title": "x"}).status_code == 404
    assert client.patch(f"/api/books/{a['id']}", content="not json").status_code == 400


def test_reindex_uses_current_cap_and_keeps_progress(client, monkeypatch):
    monkeypatch.setattr(library_module, "MAX_TEXT_CHUNKS", 2)
    b = add(client, title="His Last Bow", text=TEXT)
    assert b["chunks"] == 3  # summary + 2 capped passages
    client.put(f"/api/books/{b['id']}/progress", json={"offset": 50, "page": 1})
    monkeypatch.setattr(library_module, "MAX_TEXT_CHUNKS", 1000)
    r = client.post(f"/api/books/{b['id']}/reindex", headers={"X-Job-Id": "re-1"})
    assert r.status_code == 200 and r.json()["chunks"] > 3 and r.json()["progress"]["char_offset"] == 50
    assert client.app.state.services.library.col.count() == r.json()["chunks"]
    assert client.get("/api/jobs/re-1").json()["stage"] == "done"
    assert client.post("/api/books/nope/reindex").status_code == 404


def test_bulk_add_with_series_reports_book_progress(client):
    books = [{"title": t, "author": "Arthur Conan Doyle", "description": "d", "series": "Sherlock Holmes", "series_index": i,
              "text": TEXT} for i, t in enumerate(["A Study in Scarlet", "The Sign of the Four", "The Hound of the Baskervilles"], 1)]
    r = client.post("/api/books/bulk", json={"books": books}, headers={"X-Job-Id": "bulk-1"})
    assert r.status_code == 201 and [b["series_index"] for b in r.json()["created"]] == [1.0, 2.0, 3.0]
    job = client.get("/api/jobs/bulk-1").json()
    assert (job["label"], job["stage"], job["done"], job["total"]) == ("Adding 3 books", "done", 3, 3)


def test_series_reaches_chat_sources(client):
    add(client, title="The Hound of the Baskervilles", description="A spectral hound haunts the moors of Dartmoor.", series="Sherlock Holmes",
        series_index=3)
    r = client.post("/api/chat", json={"message": "spectral hound moors dartmoor"})
    assert '"series": "Sherlock Holmes"' in r.text and '"series_index": 3.0' in r.text


def test_bulk_fills_existing_textless_entries_instead_of_skipping(client):
    entry = add(client, title="The Sign of the Four", series="Sherlock Holmes", series_index=2)  # created from a title only
    assert entry["text_chars"] == 0
    with_text = add(client, title="The Hound of the Baskervilles", text=TEXT)  # already has text → still a duplicate
    r = client.post("/api/books/bulk", json={"books": [
        {"title": "The Sign of the Four", "author": "arthur conan doyle", "description": "d", "text": TEXT,
         "series": "Sherlock Holmes", "series_index": 2},
        {"title": "The Hound of the Baskervilles", "author": "Arthur Conan Doyle", "description": "d", "text": TEXT},
    ]})
    body = r.json()
    assert [b["id"] for b in body["created"]] == [entry["id"]] and body["created"][0]["text_chars"] == len(TEXT)
    assert body["created"][0]["series_index"] == 2.0 and body["created"][0]["chunks"] > 1
    assert len(body["errors"]) == 1 and len(client.get("/api/books").json()) == 2
    assert with_text["id"] not in [b["id"] for b in body["created"]]
