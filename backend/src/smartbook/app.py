"""Starlette app: REST + SSE API under /api, and the built React frontend at /."""

import asyncio
import json
import logging
import re
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from .chat import ChatService
from .config import PROJECT_DIR, Settings, load_settings
from .db import Store
from .importers import ImportErrorBadFile, normalize, parse_upload
from .library import Library
from .llm import FakeLLM, LLMError, OllamaClient
from . import media
from .moderation import SemanticModerator, check_rules
from .seed import seed_library

log = logging.getLogger("smartbook")
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_AUDIO_BYTES = 10 * 1024 * 1024
MEDIA_NAME = re.compile(r"^[\w-]+\.(webp|png)$")


@dataclass
class Services:
    settings: Settings
    store: Store
    llm: OllamaClient | FakeLLM
    library: Library
    chat: ChatService
    images: media.ImageGenerator | media.FakeImageGenerator
    stt: media.Transcriber | media.FakeTranscriber
    tts: media.Speaker | media.FakeSpeaker
    seeding: bool = False


def build_services(settings: Settings) -> Services:
    llm = (FakeLLM(num_ctx=settings.num_ctx) if settings.fake_llm
           else OllamaClient(settings.ollama_url, settings.embed_model, settings.num_ctx, settings.embed_on_cpu))
    store = Store(settings.data_dir / "smartbook.db")
    library = Library(store, llm, settings.data_dir / "chroma")
    moderator = SemanticModerator(llm, settings.moderation_threshold)
    fake = settings.fake_llm
    prefs_file = settings.data_dir / "hardware.json"
    device = json.loads(prefs_file.read_text()).get("images", "gpu") if prefs_file.is_file() else "gpu"
    return Services(settings, store, llm, library, ChatService(settings, store, library, moderator, llm),
                    media.FakeImageGenerator() if fake
                    else media.ImageGenerator(device=device, before_gpu=llm.unload_all_sync),
                    media.FakeTranscriber() if fake else media.Transcriber(),
                    media.FakeSpeaker() if fake else media.Speaker())


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
                             "books": svc.store.count_books(), "seeding": svc.seeding,
                             "media": {"images": True, "tts": True, "stt": True} if settings.fake_llm
                             else media.available()})

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
        book = svc.store.get_book(request.path_params["book_id"])
        if not book or not svc.library.delete_book(book["id"]):
            return error(404, "Book not found")
        if book["cover_url"]:
            (settings.data_dir / "covers" / book["cover_url"].rsplit("/", 1)[-1]).unlink(missing_ok=True)
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

        await asyncio.to_thread(svc.images.release)  # give the GPU back to the chat model

        async def stream():
            try:
                async for event, data in svc.chat.run(sid, message, model, conv_id):
                    yield f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
            except Exception:
                log.exception("chat pipeline failed")
                yield f"event: error\ndata: {json.dumps({'message': 'Something went wrong on the server.'})}\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    # --- media: covers, illustrations, speech ---------------------------------
    media_dirs = {"covers": settings.data_dir / "covers", "images": settings.data_dir / "images"}
    for d in media_dirs.values():
        d.mkdir(parents=True, exist_ok=True)

    async def render(prompt: str, width: int, height: int, seed: int) -> bytes:
        verdict = check_rules(prompt, 10_000)  # book text is user-editable, so prompts pass L1 too
        if not verdict.allowed:
            raise ValueError(verdict.message)
        return await asyncio.to_thread(svc.images.generate, prompt, width, height, seed)

    async def generate_cover(request: Request) -> JSONResponse:
        book = svc.store.get_book(request.path_params["book_id"])
        if not book:
            return error(404, "Book not found")
        try:
            data = await render(media.cover_prompt(book), 384, 512, seed=int(time.time()))
        except media.MediaUnavailable as e:
            return error(503, str(e))
        except ValueError as e:
            return error(422, str(e))
        name = f"{book['id']}-{int(time.time() * 1000)}.{svc.images.ext}"
        (media_dirs["covers"] / name).write_bytes(data)
        old = book["cover_url"]
        svc.store.set_cover(book["id"], name)
        if old:
            (media_dirs["covers"] / old.rsplit("/", 1)[-1]).unlink(missing_ok=True)
        return JSONResponse(svc.store.get_book(book["id"]))

    async def illustrate(request: Request) -> JSONResponse:
        book = svc.store.get_book(request.path_params["book_id"])
        if not book:
            return error(404, "Book not found")
        try:
            data = await render(media.scene_prompt(book), 576, 384, seed=int(time.time()))
        except media.MediaUnavailable as e:
            return error(503, str(e))
        except ValueError as e:
            return error(422, str(e))
        name = f"{uuid.uuid4().hex}.{svc.images.ext}"
        (media_dirs["images"] / name).write_bytes(data)
        return JSONResponse({"url": f"/api/media/images/{name}", "caption": f"A scene inspired by {book['title']}"},
                            status_code=201)

    async def media_file(request: Request):
        kind, name = request.path_params["kind"], request.path_params["name"]
        path = media_dirs.get(kind, settings.data_dir / "_") / name
        if kind not in media_dirs or not MEDIA_NAME.match(name) or not path.is_file():
            return error(404, "Not found")
        return FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable"})

    async def hardware(request: Request) -> JSONResponse:
        if request.method == "POST":
            try:
                device = (await request.json()).get("images")
            except json.JSONDecodeError:
                device = None
            if device not in ("gpu", "cpu"):
                return error(400, 'Body must be {"images": "gpu" | "cpu"}')
            await asyncio.to_thread(svc.images.set_device, device)
            (settings.data_dir / "hardware.json").write_text(json.dumps({"images": device}))
        return JSONResponse(await hardware_status())

    async def hardware_status() -> dict:
        import psutil

        vm = psutil.virtual_memory()
        gpu = await asyncio.to_thread(media.gpu_status)
        chat_models = []
        for m in await svc.llm.loaded_models():
            size, vram = m.get("size", 0), m.get("size_vram", 0)
            chat_models.append({"name": m.get("name"), "size_gb": round(size / 1e9, 2), "vram_gb": round(vram / 1e9, 2),
                                "gpu_pct": round(100 * vram / size) if size else 0})
        return {
            "gpu": gpu,
            "ram": {"total_gb": round(vm.total / 2**30, 1), "used_gb": round(vm.used / 2**30, 1)},  # GiB, like Windows
            "ollama": chat_models,
            "images": {"setting": svc.images.device, "running_on": svc.images.effective_device,
                       "gpu_available": media.cuda_build() and gpu is not None},
            "placement": {"chat": "gpu+cpu" if chat_models else "not loaded", "embeddings": "cpu" if settings.embed_on_cpu
                          else "gpu", "voice": "cpu"},
        }

    async def voices(request: Request) -> JSONResponse:
        return JSONResponse([{"id": k, "label": v} for k, v in media.VOICES.items()])

    async def tts(request: Request) -> Response:
        try:
            body = await request.json()
        except json.JSONDecodeError:
            return error(400, "Body must be JSON")
        text = str(body.get("text") or "").strip()
        if not text:
            return error(400, "Nothing to read")
        try:
            audio = await asyncio.to_thread(svc.tts.speak, text, str(body.get("voice") or media.DEFAULT_VOICE))
        except media.MediaUnavailable as e:
            return error(503, str(e))
        return Response(audio, media_type="audio/wav")

    async def stt(request: Request) -> JSONResponse:
        try:
            form = await request.form(max_files=1, max_part_size=MAX_AUDIO_BYTES)
        except Exception as e:
            return error(400, f"Upload failed: {e}")
        upload = form.get("audio")
        if upload is None or isinstance(upload, str):
            return error(400, "Send the recording as multipart field 'audio'")
        data = await upload.read()
        if not data:
            return error(400, "The recording is empty")
        try:
            text = await asyncio.to_thread(svc.stt.transcribe, data)
        except media.MediaUnavailable as e:
            return error(503, str(e))
        except Exception as e:  # undecodable audio from the browser
            log.warning("transcription failed: %s", e)
            return error(422, "Couldn't understand that recording — try again.")
        return JSONResponse({"text": text})

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
        Route("/api/books/{book_id}/cover", generate_cover, methods=["POST"]),
        Route("/api/books/{book_id}/illustrate", illustrate, methods=["POST"]),
        Route("/api/media/{kind}/{name}", media_file),
        Route("/api/voices", voices),
        Route("/api/hardware", hardware, methods=["GET", "POST"]),
        Route("/api/tts", tts, methods=["POST"]),
        Route("/api/stt", stt, methods=["POST"]),
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
