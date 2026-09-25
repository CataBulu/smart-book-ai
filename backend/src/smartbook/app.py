"""Starlette app: REST + SSE API under /api, and the built React frontend at /."""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from .chat import ChatService
from .config import PROJECT_DIR, Settings, load_settings
from .db import Store
from .importers import ImportErrorBadFile, normalize, parse_upload
from .library import Library
from .llm import FakeLLM, LLMError, OllamaClient
from .moderation import SemanticModerator
from .seed import seed_library

log = logging.getLogger("smartbook")
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


@dataclass
class Services:
    settings: Settings
    store: Store
    llm: OllamaClient | FakeLLM
    library: Library
    chat: ChatService
    seeding: bool = False


def build_services(settings: Settings) -> Services:
    llm = (FakeLLM(num_ctx=settings.num_ctx) if settings.fake_llm
           else OllamaClient(settings.ollama_url, settings.embed_model, settings.num_ctx, settings.embed_on_cpu))
    store = Store(settings.data_dir / "smartbook.db")
    library = Library(store, llm, settings.data_dir / "chroma")
    moderator = SemanticModerator(llm, settings.moderation_threshold)
    return Services(settings, store, llm, library, ChatService(settings, store, library, moderator, llm))


def error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def session_id(request: Request) -> str:
    return request.headers.get("x-session-id", "anonymous")[:64]


def create_app(settings: Settings | None = None) -> Starlette:
    settings = settings or load_settings()
    svc = build_services(settings)

    async def add_one(request: Request, raw: dict) -> dict:
        book, tokens = await svc.library.add_book(normalize(raw, raw.get("source", "manual")))
        svc.store.add_usage(session_id(request), None, settings.embed_model, "index", tokens, 0,
                            settings.cost(settings.embed_model, tokens, 0))
        return book

    # --- routes --------------------------------------------------------------
    async def health(request: Request) -> JSONResponse:
        return JSONResponse({"ok": True, "llm": svc.llm.name, "ollama_up": await svc.llm.is_up(),
                             "models": {**settings.chat_models, "embed": settings.embed_model},
                             "books": svc.store.count_books(), "seeding": svc.seeding})

    async def models(request: Request) -> JSONResponse:
        labels = {"pro": "Smart Book Pro", "lite": "Smart Book Lite"}
        return JSONResponse([{"id": key, "label": labels[key], "model": model, "num_ctx": settings.num_ctx}
                             for key, model in settings.chat_models.items()])

    async def list_books(request: Request) -> JSONResponse:
        return JSONResponse(svc.store.list_books())

    async def create_book(request: Request) -> JSONResponse:
        try:
            return JSONResponse(await add_one(request, await request.json()), status_code=201)
        except json.JSONDecodeError:
            return error(400, "Body must be JSON")
        except ValueError as e:
            return error(409 if "already in the library" in str(e) else 400, str(e))
        except LLMError as e:
            return error(503, f"Could not embed the book — is Ollama running? {e}")

    async def bulk_books(request: Request) -> JSONResponse:
        try:
            items = (await request.json()).get("books")
        except (json.JSONDecodeError, AttributeError):
            return error(400, "Body must be {\"books\": [...]}")
        if not isinstance(items, list) or not items:
            return error(400, "Body must be {\"books\": [...]}")
        created, errors = [], []
        for raw in items:
            try:
                created.append(await add_one(request, raw if isinstance(raw, dict) else {}))
            except ValueError as e:
                errors.append(str(e))
            except LLMError as e:
                return error(503, f"Could not embed books — is Ollama running? {e}")
        return JSONResponse({"created": created, "errors": errors}, status_code=201 if created else 400)

    async def delete_book(request: Request) -> JSONResponse:
        if not svc.library.delete_book(request.path_params["book_id"]):
            return error(404, "Book not found")
        return JSONResponse({"deleted": True})

    async def export_books(request: Request) -> JSONResponse:
        return JSONResponse(svc.store.export_books(),
                            headers={"Content-Disposition": 'attachment; filename="smart-book-library.json"'})

    async def import_preview(request: Request) -> JSONResponse:
        try:
            form = await request.form(max_files=1, max_part_size=MAX_UPLOAD_BYTES)
        except Exception as e:  # multipart errors surface as several types
            return error(400, f"Upload failed: {e}")
        upload = form.get("file")
        if upload is None or isinstance(upload, str):
            return error(400, "Send the document as multipart field 'file'")
        data = await upload.read()
        if len(data) > MAX_UPLOAD_BYTES:
            return error(413, "File is larger than 25 MB")
        try:
            drafts = await asyncio.to_thread(parse_upload, upload.filename or "upload", data)
        except ImportErrorBadFile as e:
            return error(422, str(e))
        return JSONResponse({"drafts": drafts})

    async def list_conversations(request: Request) -> JSONResponse:
        return JSONResponse(svc.store.list_conversations())

    async def get_conversation(request: Request) -> JSONResponse:
        conv = svc.store.get_conversation(request.path_params["conv_id"])
        if not conv:
            return error(404, "Conversation not found")
        return JSONResponse({**conv, "messages": svc.store.messages(conv["id"])})

    async def delete_conversation(request: Request) -> JSONResponse:
        if not svc.store.delete_conversation(request.path_params["conv_id"]):
            return error(404, "Conversation not found")
        return JSONResponse({"deleted": True})

    async def usage(request: Request) -> JSONResponse:
        return JSONResponse(svc.store.usage_summary(session_id(request)))

    async def chat(request: Request):
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return error(400, "Body must be JSON")
        message = str(body.get("message") or "")
        model = body.get("model") if body.get("model") in settings.chat_models else "pro"
        conv_id = body.get("conversation_id") or None
        sid = session_id(request)

        async def stream():
            try:
                async for event, data in svc.chat.run(sid, message, model, conv_id):
                    yield f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
            except Exception:
                log.exception("chat pipeline failed")
                yield f"event: error\ndata: {json.dumps({'message': 'Something went wrong on the server.'})}\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    routes = [
        Route("/api/health", health),
        Route("/api/models", models),
        Route("/api/books", list_books),
        Route("/api/books", create_book, methods=["POST"]),
        Route("/api/books/bulk", bulk_books, methods=["POST"]),
        Route("/api/books/export", export_books),
        Route("/api/books/{book_id}", delete_book, methods=["DELETE"]),
        Route("/api/import/preview", import_preview, methods=["POST"]),
        Route("/api/conversations", list_conversations),
        Route("/api/conversations/{conv_id}", get_conversation),
        Route("/api/conversations/{conv_id}", delete_conversation, methods=["DELETE"]),
        Route("/api/usage", usage),
        Route("/api/chat", chat, methods=["POST"]),
    ]
    dist = PROJECT_DIR / "frontend" / "dist"
    if dist.is_dir():
        routes.append(Mount("/", StaticFiles(directory=dist, html=True)))

    @asynccontextmanager
    async def lifespan(app: Starlette):
        task = None
        if settings.autoseed and svc.store.count_books() == 0:
            async def run_seed():
                svc.seeding = True
                try:
                    log.info("Seeded %d books", await seed_library(svc.library))
                except Exception:
                    log.exception("Auto-seed failed (is Ollama running?) — run `uv run python -m smartbook.seed`")
                finally:
                    svc.seeding = False
            task = asyncio.create_task(run_seed())
        yield
        if task and not task.done():
            task.cancel()

    app = Starlette(routes=routes, lifespan=lifespan)
    app.state.services = svc
    return app


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    settings = load_settings()
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port)
