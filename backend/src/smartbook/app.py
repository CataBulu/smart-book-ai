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
from .importers import ImportErrorBadFile, clean_patch, normalize, parse_upload
from .library import Library
from .llm import FakeLLM, LLMError, OllamaClient
from . import media
from .moderation import SemanticModerator, check_rules
from .classics import attach_classics
from .seed import seed_library

log = logging.getLogger("smartbook")
MAX_AUDIO_BYTES = 10 * 1024 * 1024
MEDIA_NAME = re.compile(r"^[\w-]+\.(webp|png)$")


@dataclass
class Services:
    settings: Settings
    store: Store
    llm: OllamaClient | FakeLLM
    library: Library
    chat: ChatService
    jobs: dict
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
    return Services(settings, store, llm, library, ChatService(settings, store, library, moderator, llm), {},
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

    def track(request: Request, label: str):
        """Progress reporter for a long request. The browser sends X-Job-Id and polls GET /api/jobs/{id}.
        Returns update(stage, done, total) — a no-op when the client didn't ask for progress."""
        job_id = request.headers.get("x-job-id", "")[:64]
        if not job_id:
            return lambda stage, done, total: None
        cutoff = time.time() - 600
        for old in [k for k, j in svc.jobs.items() if j["updated"] < cutoff]:
            svc.jobs.pop(old, None)
        job = svc.jobs[job_id] = {"label": label, "stage": "starting", "done": 0, "total": 0,
                                  "started": time.time(), "stage_started": time.time(), "updated": time.time()}

        def update(stage: str, done: int, total: int) -> None:  # called from worker threads too; dict ops are atomic
            if stage != job["stage"]:
                job["stage_started"] = time.time()
            job.update(stage=stage, done=done, total=total, updated=time.time())
        return update

    async def job_status(request: Request) -> JSONResponse:
        job = svc.jobs.get(request.path_params["job_id"])
        if not job:
            return error(404, "No such job")
        now = time.time()
        done, total = job["done"], job["total"]
        running = now - job["stage_started"]
        eta = round(running / done * (total - done)) if done and total and job["stage"] not in ("done", "failed") else None
        return JSONResponse({"label": job["label"], "stage": job["stage"], "done": done, "total": total,
                             "percent": round(100 * done / total, 1) if total else 0.0,
                             "elapsed_s": round(now - job["started"]), "eta_s": eta})

    async def read_upload(request: Request, field: str) -> tuple[str, bytes] | JSONResponse:
        """The uploaded file's name and bytes, or an error response. Size is checked before reading into memory."""
        try:
            form = await request.form(max_files=1)
        except Exception as e:  # multipart errors surface as several types
            return error(400, f"Upload failed: {e}")
        upload = form.get(field)
        if upload is None or isinstance(upload, str):
            return error(400, f"Send the file as multipart field '{field}'")
        if (upload.size or 0) > settings.max_upload_mb * 1024 * 1024:
            return error(413, f"That file is {upload.size / 2**20:.0f} MB; the limit is {settings.max_upload_mb} MB "
                              "(SMARTBOOK_MAX_UPLOAD_MB).")
        return upload.filename or "upload", await upload.read()

    async def add_one(request: Request, raw: dict, progress=None) -> dict:
        book = normalize(raw, raw.get("source", "manual"))
        if len(book["text"]) > 5000:
            await asyncio.to_thread(svc.images.release)  # the GPU is about to index a whole book
        book, tokens = await svc.library.add_book(
            book, on_progress=(lambda d, t: progress("indexing", d, t)) if progress else None)
        svc.store.add_usage(session_id(request), None, settings.embed_model, "index", tokens, 0,
                            settings.cost(settings.embed_model, tokens, 0))
        return book

    # --- routes --------------------------------------------------------------
    async def health(request: Request) -> JSONResponse:
        return JSONResponse({"ok": True, "llm": svc.llm.name, "ollama_up": await svc.llm.is_up(),
                             "models": {**settings.chat_models, "embed": settings.embed_model},
                             "books": svc.store.count_books(), "seeding": svc.seeding,
                             "max_upload_mb": settings.max_upload_mb,
                             "media": {"images": True, "tts": True, "stt": True} if settings.fake_llm
                             else media.available()})

    async def models(request: Request) -> JSONResponse:
        labels = {"pro": "Smart Book Pro", "lite": "Smart Book Lite"}
        return JSONResponse([{"id": key, "label": labels[key], "model": model, "num_ctx": settings.num_ctx}
                             for key, model in settings.chat_models.items()])

    async def list_books(request: Request) -> JSONResponse:
        progress = svc.store.progress_map()
        return JSONResponse([{**b, "progress": progress.get(b["id"])} for b in svc.store.list_books()])

    async def book_content(request: Request) -> JSONResponse:
        book = svc.store.get_book(request.path_params["book_id"])
        if not book:
            return error(404, "Book not found")
        return JSONResponse({"id": book["id"], "title": book["title"], "author": book["author"],
                             "text": svc.store.get_text(book["id"]) or "",
                             "progress": svc.store.progress_map([book["id"]]).get(book["id"])})

    async def save_progress(request: Request) -> JSONResponse:
        book = svc.store.get_book(request.path_params["book_id"])
        if not book:
            return error(404, "Book not found")
        try:
            body = await request.json()
            offset, page = int(body["offset"]), int(body["page"])
            pages = int(body["pages"]) if body.get("pages") is not None else None
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            return error(400, 'Body must be {"offset": int, "page": int, "pages": int | null}')
        if offset < 0 or page < 1 or (pages is not None and pages < page) or offset > book["text_chars"]:
            return error(400, "Position is outside the book")
        return JSONResponse(svc.store.save_progress(book["id"], offset, page, pages))

    async def attach_text(request: Request) -> JSONResponse:
        book_id = request.path_params["book_id"]
        if not svc.store.get_book(book_id):
            return error(404, "Book not found")
        got = await read_upload(request, "file")
        if isinstance(got, JSONResponse):
            return got
        progress = track(request, f"Adding the text of “{svc.store.get_book(book_id)['title']}”")
        try:
            drafts = await asyncio.to_thread(parse_upload, *got, lambda d, t: progress("reading", d, t))
        except ImportErrorBadFile as e:
            progress("failed", 0, 0)
            return error(422, str(e))
        text = next((d["text"] for d in drafts if d["text"].strip()), "")
        if len(text.strip()) < 200:
            return error(422, "That file has no readable book text (scanned PDFs need OCR first).")
        await asyncio.to_thread(svc.images.release)  # the GPU is about to index a whole book
        try:
            book, tokens = await svc.library.replace_text(book_id, text, lambda d, t: progress("indexing", d, t))
            progress("done", 1, 1)
        except LLMError as e:
            progress("failed", 0, 0)
            return error(503, f"Could not index the text — is Ollama running? {e}")
        svc.store.add_usage(session_id(request), None, settings.embed_model, "index", tokens, 0,
                            settings.cost(settings.embed_model, tokens, 0))
        return JSONResponse({**book, "progress": None})

    async def create_book(request: Request) -> JSONResponse:
        try:
            raw = await request.json()
            progress = track(request, f"Adding “{raw.get('title', 'book')}”" if isinstance(raw, dict) else "Adding a book")
            book = await add_one(request, raw, progress)
            progress("done", 1, 1)
            return JSONResponse(book, status_code=201)
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
        progress = track(request, f"Adding {len(items)} books")
        for i, raw in enumerate(items):
            progress("indexing", i, len(items))
            # fractional progress inside each book, so the bar keeps moving while a big book indexes
            within = (lambda _stage, d, t, i=i: progress("indexing", i + (d / t if t else 0), len(items)))
            try:
                created.append(await add_one(request, raw if isinstance(raw, dict) else {}, within))
            except ValueError as e:
                filled = await fill_existing(raw, within) if "already in the library" in str(e) else None
                if filled:
                    created.append(filled)
                else:
                    errors.append(str(e))
            except LLMError as e:
                return error(503, f"Could not embed books — is Ollama running? {e}")
        progress("done", len(items), len(items))
        return JSONResponse({"created": created, "errors": errors}, status_code=201 if created else 400)

    async def fill_existing(raw: dict, progress) -> dict | None:
        """A bulk item matching a book already in the library that has no text yet (e.g. a series entry created from
        titles) fills that book in — text, and series if given — instead of being skipped as a duplicate."""
        book = normalize(raw, raw.get("source", "import"))
        existing = svc.store.find_book_exact(book["title"])
        if not existing or existing["author"].lower() != book["author"].lower() or existing["text_chars"] or not book["text"]:
            return None
        await asyncio.to_thread(svc.images.release)
        updated, _ = await svc.library.replace_text(existing["id"], book["text"],
                                                    (lambda d, t: progress("indexing", d, t)) if progress else None)
        if book["series"]:
            updated, _ = await svc.library.update_details(existing["id"], {"series": book["series"],
                                                                            "series_index": book["series_index"]})
        return updated

    async def update_book(request: Request) -> JSONResponse:
        book_id = request.path_params["book_id"]
        try:
            fields = clean_patch(await request.json())
            book, tokens = await svc.library.update_details(book_id, fields)
        except json.JSONDecodeError:
            return error(400, "Body must be JSON")
        except KeyError:
            return error(404, "Book not found")
        except ValueError as e:
            return error(409 if "already in the library" in str(e) else 400, str(e))
        except LLMError as e:
            return error(503, f"Saved details could not be indexed — is Ollama running? {e}")
        svc.store.add_usage(session_id(request), None, settings.embed_model, "index", tokens, 0,
                            settings.cost(settings.embed_model, tokens, 0))
        return JSONResponse({**book, "progress": svc.store.progress_map([book_id]).get(book_id)})

    async def reindex_book(request: Request) -> JSONResponse:
        book_id = request.path_params["book_id"]
        book = svc.store.get_book(book_id)
        if not book:
            return error(404, "Book not found")
        progress = track(request, f"Re-indexing “{book['title']}”")
        await asyncio.to_thread(svc.images.release)
        try:
            book, tokens = await svc.library.reindex(book_id, lambda d, t: progress("indexing", d, t))
        except LLMError as e:
            progress("failed", 0, 0)
            return error(503, f"Could not index — is Ollama running? {e}")
        progress("done", 1, 1)
        svc.store.add_usage(session_id(request), None, settings.embed_model, "index", tokens, 0,
                            settings.cost(settings.embed_model, tokens, 0))
        return JSONResponse({**book, "progress": svc.store.progress_map([book_id]).get(book_id)})

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
        got = await read_upload(request, "file")
        if isinstance(got, JSONResponse):
            return got
        progress = track(request, f"Reading {got[0]}")
        try:
            drafts = await asyncio.to_thread(parse_upload, *got, lambda d, t: progress("reading", d, t))
        except ImportErrorBadFile as e:
            progress("failed", 0, 0)
            return error(422, str(e))
        progress("done", 1, 1)
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
        Route("/api/books/{book_id}", update_book, methods=["PATCH"]),
        Route("/api/books/{book_id}/reindex", reindex_book, methods=["POST"]),
        Route("/api/import/preview", import_preview, methods=["POST"]),
        Route("/api/conversations", list_conversations),
        Route("/api/conversations/{conv_id}", get_conversation),
        Route("/api/conversations/{conv_id}", delete_conversation, methods=["DELETE"]),
        Route("/api/usage", usage),
        Route("/api/books/{book_id}/cover", generate_cover, methods=["POST"]),
        Route("/api/books/{book_id}/content", book_content),
        Route("/api/books/{book_id}/progress", save_progress, methods=["PUT"]),
        Route("/api/books/{book_id}/text", attach_text, methods=["POST"]),
        Route("/api/books/{book_id}/illustrate", illustrate, methods=["POST"]),
        Route("/api/media/{kind}/{name}", media_file),
        Route("/api/voices", voices),
        Route("/api/jobs/{job_id}", job_status),
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
                    log.info("Attached full text to %d public-domain classics", attach_classics(svc.store))
                except Exception:
                    log.exception("Auto-seed failed (is Ollama running?) — run `uv run python -m smartbook.seed`")
                finally:
                    svc.seeding = False
            task = asyncio.create_task(run_seed())
        else:
            attach_classics(svc.store)  # cheap: only fills classics that have no text yet
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
