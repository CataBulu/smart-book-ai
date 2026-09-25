TEXT = "\n\n".join(f"Paragraph {i}. The lantern swung above the harbour as the ferry came in." for i in range(120))


def add(client, title, **extra):
    r = client.post("/api/books", json={"title": title, "author": "A. Writer", "description": "d", **extra})
    assert r.status_code == 201, r.text
    return r.json()


def titles(client):
    return [b["title"] for b in client.get("/api/books").json()]


def test_new_books_go_last_and_order_can_be_saved(client):
    a, b, c = (add(client, t) for t in ("Alpha", "Bravo", "Charlie"))
    assert titles(client) == ["Alpha", "Bravo", "Charlie"]
    r = client.put("/api/books/order", json={"ids": [c["id"], a["id"]]})  # books left out keep their place after
    assert r.json() == {"ok": True, "count": 3}
    assert titles(client) == ["Charlie", "Alpha", "Bravo"]
    add(client, "Delta")
    assert titles(client)[-1] == "Delta"
    assert client.put("/api/books/order", json={"ids": "nope"}).status_code == 400
    assert client.put("/api/books/order", content="x").status_code == 400


def cancel_after_first_batch(client, job_id):
    """Make the library 'press Cancel' as soon as the first batch of passages has been embedded."""
    library = client.app.state.services.library
    original = library.embed

    async def embed(texts, on_progress=None):
        def progress(d, t):
            client.app.state.services.jobs[job_id]["cancelled"] = True
            if on_progress:
                on_progress(d, t)
        return await original(texts, progress)

    library.embed = embed


def test_cancelled_add_saves_nothing(client):
    cancel_after_first_batch(client, "job-a")
    r = client.post("/api/books", json={"title": "Harbour", "author": "A", "description": "d", "text": TEXT},
                    headers={"X-Job-Id": "job-a"})
    assert r.status_code == 409 and r.json() == {"error": "Cancelled", "cancelled": True}
    assert titles(client) == [] and client.app.state.services.library.col.count() == 0
    assert client.get("/api/jobs/job-a").json()["stage"] == "cancelled"


def test_cancelled_bulk_keeps_finished_books(client):
    books = [{"title": t, "author": "A", "description": "d"} for t in ("One", "Two", "Three")]
    seen = []
    library = client.app.state.services.library
    original = library.add_book

    async def add_book(book, on_progress=None):
        seen.append(book["title"])
        if len(seen) == 2:  # Cancel pressed while the second book is being added
            client.app.state.services.jobs["job-b"]["cancelled"] = True
        return await original(book, on_progress)

    library.add_book = add_book
    r = client.post("/api/books/bulk", json={"books": books}, headers={"X-Job-Id": "job-b"})
    body = r.json()
    assert r.status_code == 200 and body["cancelled"] is True
    # "Two" was stopped mid-way, so only the finished "One" is kept — nothing half-added
    assert [b["title"] for b in body["created"]] == ["One"] and titles(client) == ["One"]


def test_cancel_endpoint(client):
    assert client.post("/api/jobs/nope/cancel").status_code == 404
    client.post("/api/books", json={"title": "Quick", "author": "A", "description": "d"}, headers={"X-Job-Id": "job-c"})
    assert client.post("/api/jobs/job-c/cancel").json() == {"cancelled": True}
