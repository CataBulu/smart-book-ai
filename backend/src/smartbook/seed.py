"""Load seed/books.json into the library: `uv run python -m smartbook.seed`."""

import asyncio
import json
from pathlib import Path

from .config import BACKEND_DIR
from .importers import normalize

SEED_FILE = BACKEND_DIR / "seed" / "books.json"


async def seed_library(library, path: Path = SEED_FILE) -> int:
    """Adds every seed book not already present. Returns how many were added."""
    added = 0
    for raw in json.loads(path.read_text(encoding="utf-8")):
        book = normalize(raw, "seed")
        if not library.store.book_exists(book["title"], book["author"]):
            await library.add_book(book)
            added += 1
    return added


def main() -> None:
    from .app import build_services
    from .config import load_settings

    library = build_services(load_settings()).library
    added = asyncio.run(seed_library(library))
    print(f"Seeded {added} new books; library now has {library.store.count_books()} books.")


if __name__ == "__main__":
    main()
