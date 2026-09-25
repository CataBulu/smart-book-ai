"""The library: SQLite books + ChromaDB chunk index + Qwen3 embeddings + thresholded semantic search."""

from dataclasses import dataclass
from pathlib import Path

import chromadb
from chromadb.config import Settings as ChromaSettings

from .db import Store

# Qwen3-Embedding is instruction-aware: queries get a task prefix, documents are embedded raw.
QUERY_INSTRUCTION = ("Instruct: Given a user's request for a book, retrieve library passages describing books "
                     "that match it\nQuery: ")
CHUNK_CHARS = 1200
CHUNK_OVERLAP = 200
MAX_TEXT_CHUNKS = 1000  # ~1.2M chars searchable (typical novels in full); ~4 min on the GPU at the cap
EMBED_BATCH = 16  # small enough for smooth progress, big enough to keep the GPU busy
BULK_MIN = 8  # this many passages or more → index on the GPU


def as_query(text: str) -> str:
    return QUERY_INSTRUCTION + text


def summary_document(book: dict) -> str:
    parts = [f"{book['title']} by {book['author']}."]
    if book.get("genres"):
        parts.append("Genres: " + ", ".join(book["genres"]) + ".")
    if book.get("themes"):
        parts.append("Themes: " + ", ".join(book["themes"]) + ".")
    parts.append(book["description"])
    return "\n".join(parts)


def text_chunks(text: str, size: int = CHUNK_CHARS, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Paragraph-aware packing into ~size-char chunks; each chunk starts with the tail of the previous one."""
    paragraphs = [p.strip() for p in text.replace("\r\n", "\n").split("\n\n") if p.strip()]
    pieces: list[str] = []
    for p in paragraphs:  # split oversized paragraphs hard so no chunk runs away
        pieces += [p[i:i + size] for i in range(0, len(p), size)]
    chunks: list[str] = []
    current = ""
    for piece in pieces:
        if current and len(current) + len(piece) + 2 > size:
            chunks.append(current)
            current = current[-overlap:] + "\n\n" + piece if overlap else piece
        else:
            current = f"{current}\n\n{piece}" if current else piece
    if current:
        chunks.append(current)
    return chunks[:MAX_TEXT_CHUNKS]


def build_chunks(book: dict) -> list[str]:
    """Chunk 0 is always the summary card; the rest come from the optional full text."""
    return [summary_document(book)] + (text_chunks(book["text"]) if book.get("text", "").strip() else [])


@dataclass
class Hit:
    book_id: str
    distance: float
    kind: str
    snippet: str

    @property
    def score(self) -> float:
        return round(1.0 - self.distance, 4)


class Library:
    def __init__(self, store: Store, llm, chroma_path: Path, collection: str = "books"):
        self.store = store
        self.llm = llm
        client = chromadb.PersistentClient(path=str(chroma_path), settings=ChromaSettings(anonymized_telemetry=False))
        self.col = client.get_or_create_collection(collection, configuration={"hnsw": {"space": "cosine"}},
                                                   embedding_function=None)

    async def embed(self, texts: list[str], on_progress=None) -> tuple[list[list[float]], int]:
        """Embeds in batches; `on_progress(done, total)` after each batch. Whole books go to the GPU."""
        bulk = len(texts) >= BULK_MIN
        if bulk:
            await self.llm.free_gpu_for_embedding()
        vectors, tokens = [], 0
        for i in range(0, len(texts), EMBED_BATCH):
            v, t = await self.llm.embed(texts[i:i + EMBED_BATCH], bulk=bulk)
            if on_progress:
                on_progress(min(i + EMBED_BATCH, len(texts)), len(texts))
            vectors += v
            tokens += t
        return vectors, tokens

    async def embed_query(self, text: str) -> tuple[list[float], int]:
        vectors, tokens = await self.llm.embed([as_query(text)])
        return vectors[0], tokens

    async def add_book(self, book: dict, on_progress=None) -> tuple[dict, int]:
        """Returns (stored book, embedding tokens). Raises ValueError on duplicates."""
        if self.store.book_exists(book["title"], book["author"]):
            raise ValueError(f'"{book["title"]}" by {book["author"]} is already in the library')
        chunks = build_chunks(book)
        vectors, tokens = await self.embed(chunks, on_progress)
        stored = self.store.insert_book(book, len(chunks))
        try:
            self.col.add(
                ids=[f"{stored['id']}:{i}" for i in range(len(chunks))],
                embeddings=vectors,
                documents=chunks,
                metadatas=[{"book_id": stored["id"], "kind": "summary" if i == 0 else "text", "chunk": i}
                           for i in range(len(chunks))],
            )
        except Exception:
            self.store.delete_book(stored["id"])  # keep SQLite and Chroma consistent
            raise
        return stored, tokens

    async def replace_text(self, book_id: str, text: str, on_progress=None) -> tuple[dict, int]:
        """Attach new full text to a book and rebuild its chunks in the index. Returns (book, embedding tokens)."""
        book = self.store.get_book(book_id)
        if book is None:
            raise KeyError(book_id)
        chunks = build_chunks({**book, "text": text})
        vectors, tokens = await self.embed(chunks, on_progress)
        self.col.delete(where={"book_id": book_id})
        self.col.add(
            ids=[f"{book_id}:{i}" for i in range(len(chunks))],
            embeddings=vectors,
            documents=chunks,
            metadatas=[{"book_id": book_id, "kind": "summary" if i == 0 else "text", "chunk": i}
                       for i in range(len(chunks))],
        )
        self.store.set_text(book_id, text, len(chunks))
        return self.store.get_book(book_id), tokens

    def delete_book(self, book_id: str) -> bool:
        self.col.delete(where={"book_id": book_id})
        return self.store.delete_book(book_id)

    def search(self, vector: list[float], max_distance: float, top_k: int, max_books: int) -> list[Hit]:
        """Top-k chunks → drop those beyond the relevance threshold → best chunk per book → top books."""
        count = self.col.count()
        if not count:
            return []
        res = self.col.query(query_embeddings=[vector], n_results=min(top_k, count),
                             include=["metadatas", "distances", "documents"])
        best: dict[str, Hit] = {}
        for meta, dist, doc in zip(res["metadatas"][0], res["distances"][0], res["documents"][0]):
            if dist > max_distance:
                continue
            hit = best.get(meta["book_id"])
            if hit is None or dist < hit.distance:
                best[meta["book_id"]] = Hit(meta["book_id"], dist, meta["kind"], doc)
        return sorted(best.values(), key=lambda h: h.distance)[:max_books]
