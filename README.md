# Smart Book AI

A full-stack conversational librarian that recommends **English books from your own ChromaDB library**, running
entirely on your PC with local **Qwen** models served by **Ollama**. No cloud keys, no data leaves the machine.

**Stack:** Python 3.12 · Starlette · ChromaDB · SQLite · Ollama (Qwen3.5 + Qwen3-Embedding) · React 19 · TypeScript · Vite · Playwright

## Features
- **RAG pipeline**: Qwen3 embeddings with query instructions, cosine semantic search, a **relevance threshold**
  calibrated on real data, per-book dedupe, and full-text chunk indexing for imported books.
- **Conversation-aware follow-up rewriting**: "something darker?" becomes a standalone library query.
- **Function calling**: the chat model calls `search_library` and `get_book_details` against the persistent vector DB.
- **Layered moderation before any chat-model call**: L0 validation → L1 regex rules (prompt injection, dangerous
  how-tos, self-harm with crisis resources, hate) → L2 embedding similarity to harmful exemplars.
  The L2 embedding is reused for retrieval, so moderation adds no extra model call.
- **Multi-format import**: PDF, DOCX, EPUB, Markdown/TXT, JSON (single or bulk) up to 200 MB, with a live
  progress window (percentage, pages/passages, time left); whole books are indexed on the GPU.
- **Token & cost accounting**: every embed, rewrite, chat and tool round is recorded per session and per
  conversation, with configurable cloud-equivalent $/1M-token rates. The usage popover also shows how full the context window is.
- **Read books in the app**: a two-page reader with a 3D page-turn, adjustable text size, and your place
  remembered (it reopens where you stopped; "Continue reading" on the home screen). Seven public-domain
  classics ship with full text; add the text of any other book from its page in the library.
- **Series**: group books into series (e.g. The Witcher #1–#8), see % read per book, add several files at once
  and number them in order; edit any book's details.
- **Local image generation** (SD-Turbo on CPU): paint book covers and "Illustrate" a recommended book.
- **Local voice**: Listen reads answers with Kokoro TTS; dictation uses Whisper STT — no audio leaves the PC.
- **UI**: bookshop-style design (serif titles, real and typeset covers), streaming answers with book cards,
  mood chips and a shelf on the home screen, library page with drag-and-drop import, light/dark themes, mobile layout.
  Technical details (search query, tools, match scores, tokens, cost) sit behind a Details toggle.

## Models (picked for a GTX 1650 SUPER 4 GB / Ryzen 5 2600 / 16 GB)
| Role | Model | Notes |
|---|---|---|
| Smart Book Pro | `qwen3.5:4b` | best answers, ~12 tok/s |
| Smart Book Lite | `qwen3.5:2b-q4_K_M` | fully on GPU, ~78 tok/s |
| Embeddings | `qwen3-embedding:0.6b` | runs on CPU so the chat model keeps the GPU |
| Images | `stabilityai/sd-turbo` | **GPU** (fp16 UNet, GTX 16xx NaN fix), ~4 s per image; CPU fallback ~20 s |
| Speech | Kokoro-82M (TTS), Whisper base.en (STT) | CPU |

Measurements and reasoning: [`chunks/02-hardware-and-models.md`](chunks/02-hardware-and-models.md).

## Quick start
```bash
# 1. Ollama + models (once)
ollama pull qwen3.5:4b
ollama pull qwen3.5:2b-q4_K_M
ollama pull qwen3-embedding:0.6b

# 2. Image + speech models (once, ~3 GB)
cd backend && uv run python -m smartbook.media download && cd ..

# 3. Build the UI (once, or after frontend changes)
cd frontend && npm install && npm run build && cd ..

# 4. Run: serves API + UI on http://127.0.0.1:8000 and seeds 60 books on first start
cd backend && uv run smartbook
```
Development with hot reload: run `uv run smartbook` in `backend/` and `npm run dev` in `frontend/`,
then open http://127.0.0.1:5173.

## GPU & memory
Settings → **Hardware** shows live VRAM/RAM, how much of the chat model is on the graphics card, and a
Graphics card / CPU switch for images. The image model runs in a separate process that is released before every chat
turn (and after 90 s idle), and the chat model steps aside while an image is painted. Optional Ollama tuning:
`OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`. Details: `chunks/02-hardware-and-models.md`.

## Tests
```bash
cd backend && uv run pytest          # 104 unit/API tests (fake LLM, no Ollama needed)
cd frontend && npx playwright test   # 18 smoke tests (isolated fake-LLM backend on :8001)
```

## Configuration
Copy `backend/.env.example` to `backend/.env`. Key knobs: `SMARTBOOK_RELEVANCE_MAX_DISTANCE` (0.68),
`SMARTBOOK_MODERATION_THRESHOLD` (0.60), model names, `SMARTBOOK_NUM_CTX`, and prices.

## Project layout
```
backend/src/smartbook/   app (routes, SSE) · chat (pipeline + tools) · library (Chroma, chunking)
                         moderation · rewrite · importers · llm (Ollama + fake) · db (SQLite) · config · seed
backend/seed/books.json  60 English seed books
frontend/src/            App, api (SSE client), components/, index.css (design tokens)
frontend/e2e/            Playwright smoke tests
chunks/                  project memory: brief, models, design, architecture, API contract, progress log
TODO.md                  task list with evidence
graphify-out/            code knowledge graph (graph.html, GRAPH_REPORT.md)
```

## Dev tooling
- **graphify**: code knowledge graph + Claude Code skill/hooks (`graphify update .` after code changes).
- **ponytail**: "lazy senior dev" Claude Code skills + hooks, vendored in `.claude/` (MIT).
