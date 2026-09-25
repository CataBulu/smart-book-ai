"""Public-domain full texts for the seed classics, so they can be read in the app out of the box.

`uv run python -m smartbook.classics fetch` downloads them from Project Gutenberg into seed/texts/ (already done and
committed; the Gutenberg header/licence is stripped, which is what their terms ask for when redistributing the text).
At startup `attach_classics()` gives each matching seed book its text for the reader. The texts are *not* indexed:
search stays on the curated descriptions, which retrieve better than random passages from long novels.
"""

import re
import sys

from .config import BACKEND_DIR
from .db import Store
from .importers import reading_text

TEXTS_DIR = BACKEND_DIR / "seed" / "texts"

# library title -> (Project Gutenberg ebook id, file name)
CLASSICS = {
    "Pride and Prejudice": (1342, "pride-and-prejudice.txt"),
    "Jane Eyre": (1260, "jane-eyre.txt"),
    "Frankenstein": (84, "frankenstein.txt"),
    "The Hound of the Baskervilles": (2852, "the-hound-of-the-baskervilles.txt"),
    "Walden": (205, "walden.txt"),
    "The Great Gatsby": (64317, "the-great-gatsby.txt"),
    "Mrs Dalloway": (71865, "mrs-dalloway.txt"),
}


def clean_gutenberg(raw: str, title: str) -> str:
    """Keep only the book: drop the Gutenberg header/footer, illustration markers and _italic_ underscores."""
    text = raw.replace("\r\n", "\n").lstrip("﻿")
    start = re.search(r"^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG EBOOK.*$", text, re.M | re.I)
    end = re.search(r"^\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG EBOOK.*$", text, re.M | re.I)
    text = text[start.end() if start else 0:end.start() if end else len(text)]
    if title == "Walden":  # the Gutenberg file also carries the separate essay "Civil Disobedience"
        # the title also appears on the title page, so cut at the last heading, and only in the back half
        heads = [m.start() for m in re.finditer(r"^\s*ON THE DUTY OF CIVIL DISOBEDIENCE\s*$", text, re.M)]
        if heads and heads[-1] > len(text) // 2:
            text = text[:heads[-1]]
    text = re.sub(r"\[Illustration[^\]]*\]", "", text, flags=re.S)
    text = re.sub(r"(?<!\w)_([^_\n]+(?:\n[^_\n]+)*)_(?!\w)", r"\1", text)
    text = text.replace("_", "")  # Gutenberg only uses underscores for italics (e.g. ordinals like 21_st_)
    return reading_text(text)


def fetch() -> None:
    import httpx

    TEXTS_DIR.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=60, follow_redirects=True, headers={"User-Agent": "SmartBookAI/0.1"}) as client:
        for title, (gid, name) in CLASSICS.items():
            r = client.get(f"https://www.gutenberg.org/cache/epub/{gid}/pg{gid}.txt")
            r.raise_for_status()
            text = clean_gutenberg(r.content.decode("utf-8"), title)
            (TEXTS_DIR / name).write_text(text, encoding="utf-8", newline="\n")
            print(f"{title}: {len(text):,} chars")


def attach_classics(store: Store) -> int:
    """Give seed classics their full text if they don't have one yet. Returns how many were attached."""
    attached = 0
    for title, (_, name) in CLASSICS.items():
        path = TEXTS_DIR / name
        book = store.find_book_exact(title)
        if path.is_file() and book and not book["text_chars"]:
            store.set_text(book["id"], path.read_text(encoding="utf-8"))
            attached += 1
    return attached


if __name__ == "__main__":
    if sys.argv[1:] == ["fetch"]:
        fetch()
    else:
        print("usage: python -m smartbook.classics fetch")
