from starlette.testclient import TestClient

from smartbook.app import create_app
from smartbook.config import load_settings
from test_importers import make_pdf

LONG = "\n\n".join(f"Paragraph {i}. The witcher rode on through the rain towards the town gates." for i in range(400))


def test_add_book_reports_indexing_progress(client, books, services):
    seen = []
    library = client.app.state.services.library
    original = library.embed

    async def spy(texts, on_progress=None):
        return await original(texts, lambda d, t: (seen.append((d, t)), on_progress and on_progress(d, t)))

    library.embed = spy
    r = client.post("/api/books", json=dict(books[0], text=LONG), headers={"X-Job-Id": "job-1"})
    assert r.status_code == 201
    chunks = r.json()["chunks"]
    assert seen[-1] == (chunks, chunks) and len(seen) == -(-chunks // 16)  # one update per batch of 16

    job = client.get("/api/jobs/job-1").json()
    assert job["label"] == "Adding “Walden”" and job["stage"] == "done" and job["percent"] == 100.0
    assert client.get("/api/jobs/nope").status_code == 404


def test_pdf_preview_reports_pages_read(client):
    r = client.post("/api/import/preview", files={"file": ("night.pdf", make_pdf("The lamp burned.", "Night Watch"))},
                    headers={"X-Job-Id": "job-2"})
    assert r.status_code == 200
    job = client.get("/api/jobs/job-2").json()
    assert job["label"] == "Reading night.pdf" and job["stage"] == "done"


def test_requests_without_job_id_still_work(client, books):
    assert client.post("/api/books", json=books[1]).status_code == 201


def test_upload_limit_is_configurable(tmp_path, monkeypatch):
    monkeypatch.setenv("SMARTBOOK_FAKE_LLM", "1")
    monkeypatch.setenv("SMARTBOOK_AUTOSEED", "0")
    monkeypatch.setenv("SMARTBOOK_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SMARTBOOK_MAX_UPLOAD_MB", "1")
    with TestClient(create_app(load_settings())) as c:
        assert c.get("/api/health").json()["max_upload_mb"] == 1
        big = b"x" * (1024 * 1024 + 10)
        r = c.post("/api/import/preview", files={"file": ("big.txt", big)})
        assert r.status_code == 413 and "limit is 1 MB" in r.json()["error"]
        assert c.post("/api/import/preview", files={"file": ("ok.txt", b"A short book about the sea.")}).status_code == 200


def test_default_upload_limit_is_200_mb(settings):
    assert load_settings().max_upload_mb == 200
