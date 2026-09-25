import asyncio

import pytest

from smartbook.library import CHUNK_CHARS, as_query, build_chunks, summary_document, text_chunks


def test_summary_document_has_all_fields(books):
    doc = summary_document(books[0])
    assert doc.startswith("Walden by Henry David Thoreau.")
    assert "Genres: Non-fiction." in doc and "Themes: solitude, nature." in doc


def test_text_chunks_respect_size_and_overlap():
    text = "\n\n".join(f"Paragraph {i} " + "word " * 60 for i in range(40))
    chunks = text_chunks(text)
    assert len(chunks) > 5
    assert all(len(c) <= CHUNK_CHARS + 250 for c in chunks)
    assert chunks[1][:100] in chunks[0]  # the tail of each chunk opens the next one


def test_oversized_paragraph_is_split():
    assert len(text_chunks("x" * 5000)) >= 4


def test_build_chunks_summary_first(books):
    book = dict(books[0], text="Chapter one.\n\nChapter two.")
    chunks = build_chunks(book)
    assert chunks[0] == summary_document(book) and len(chunks) == 2
    assert build_chunks(books[1]) == [summary_document(books[1])]


def test_add_search_delete(services, books):
    lib = services.library

    async def scenario():
        for b in books:
            await lib.add_book(b)
        with pytest.raises(ValueError, match="already in the library"):
            await lib.add_book(books[0])
        vec, tokens = await lib.embed_query("solitude nature cabin")
        assert tokens > 0
        return vec

    vec = asyncio.run(scenario())
    hits = lib.search(vec, max_distance=0.9, top_k=10, max_books=5)
    assert hits and services.store.get_book(hits[0].book_id)["title"] == "Walden"
    assert len({h.book_id for h in hits}) == len(hits)  # one hit per book
    assert lib.search(vec, max_distance=0.0001, top_k=10, max_books=5) == []  # threshold filters everything

    walden = hits[0].book_id
    assert lib.delete_book(walden)
    assert all(h.book_id != walden for h in lib.search(vec, 2.0, 10, 5))
    assert lib.col.count() == 2


def test_full_text_chunks_are_indexed(services, books):
    book = dict(books[1], text="\n\n".join("sandworms and melange harvesters " * 30 for _ in range(6)))
    stored, _ = asyncio.run(services.library.add_book(book))
    assert stored["chunks"] == services.library.col.count() > 1


def test_query_prefix():
    assert as_query("x").startswith("Instruct: ") and as_query("x").endswith("Query: x")
