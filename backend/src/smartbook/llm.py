"""Ollama client (native /api) plus a deterministic fake used by tests and Playwright."""

import hashlib
import json
import math
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

import httpx


@dataclass
class ChatResult:
    content: str = ""
    tool_calls: list[dict] = field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0


class LLMError(RuntimeError):
    pass


class OllamaClient:
    name = "ollama"

    def __init__(self, base_url: str, embed_model: str, num_ctx: int, embed_on_cpu: bool = True):
        self.embed_model = embed_model
        self.num_ctx = num_ctx
        # On a 4 GB GPU the embedder steals VRAM from the chat model; on CPU it is still ~60 ms per query
        # and chat prompt evaluation gets ~6x faster (measured on a GTX 1650 SUPER).
        self.embed_options = {"num_ctx": 2048, **({"num_gpu": 0} if embed_on_cpu else {})}
        self.http = httpx.AsyncClient(base_url=base_url, timeout=httpx.Timeout(600.0, connect=5.0))

    def _chat_body(self, model: str, messages: list[dict], tools: list[dict] | None, stream: bool) -> dict:
        # think=False: Qwen3.5 reasons by default, which is far too slow on a 4 GB GPU.
        body = {"model": model, "messages": messages, "stream": stream, "think": False,
                "keep_alive": "10m", "options": {"num_ctx": self.num_ctx, "temperature": 0.4}}
        if tools:
            body["tools"] = tools
        return body

    async def embed(self, texts: list[str], bulk: bool = False) -> tuple[list[list[float]], int]:
        """bulk=True (indexing a whole book): run on the GPU. On the CPU a ~300-token passage takes ~3.5 s on this PC,
        so a 300-page book took ~17 min; queries stay on the CPU (tiny, ~60 ms) so the chat model keeps the GPU."""
        # num_gpu must be explicit: Ollama keeps reusing an already-loaded CPU copy otherwise (measured: 13x slower)
        options = {"num_ctx": 2048, "num_gpu": 999} if bulk else self.embed_options
        try:
            r = await self.http.post("/api/embed", json={"model": self.embed_model, "input": texts,
                                                         "keep_alive": "30s" if bulk else "10m", "options": options})
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise LLMError(f"Embedding call failed: {e}") from e
        data = r.json()
        return data["embeddings"], data.get("prompt_eval_count", 0)

    async def chat(self, model: str, messages: list[dict]) -> ChatResult:
        try:
            r = await self.http.post("/api/chat", json=self._chat_body(model, messages, None, stream=False))
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise LLMError(f"Chat call failed: {e}") from e
        data = r.json()
        return ChatResult(data["message"].get("content", ""), [], data.get("prompt_eval_count", 0),
                          data.get("eval_count", 0))

    async def chat_stream(self, model: str, messages: list[dict], tools: list[dict] | None = None
                          ) -> AsyncIterator[str | ChatResult]:
        """Yields content tokens (str) and finally one ChatResult with tool calls and token counts."""
        result = ChatResult()
        try:
            async with self.http.stream("POST", "/api/chat", json=self._chat_body(model, messages, tools, True)) as r:
                if r.status_code >= 400:
                    raise LLMError(f"Chat call failed ({r.status_code}): {(await r.aread()).decode()[:300]}")
                async for line in r.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    if "error" in chunk:
                        raise LLMError(chunk["error"])
                    msg = chunk.get("message", {})
                    if msg.get("content"):
                        result.content += msg["content"]
                        yield msg["content"]
                    result.tool_calls += msg.get("tool_calls") or []
                    if chunk.get("done"):
                        result.prompt_tokens = chunk.get("prompt_eval_count", 0)
                        result.completion_tokens = chunk.get("eval_count", 0)
        except httpx.HTTPError as e:
            raise LLMError(f"Chat call failed: {e}") from e
        yield result

    async def is_up(self) -> bool:
        try:
            return (await self.http.get("/api/version", timeout=2.0)).status_code == 200
        except httpx.HTTPError:
            return False

    async def loaded_models(self) -> list[dict]:
        """Models Ollama currently holds in memory, with how much of each sits in VRAM."""
        try:
            r = await self.http.get("/api/ps", timeout=3.0)
            return r.json().get("models", []) if r.status_code == 200 else []
        except httpx.HTTPError:
            return []

    async def free_gpu_for_embedding(self) -> None:
        """Unload chat models so the embedder fits on the GPU for a bulk indexing run."""
        for m in await self.loaded_models():
            if m.get("name") != self.embed_model and m.get("size_vram"):
                try:
                    await self.http.post("/api/generate", json={"model": m["name"], "keep_alive": 0}, timeout=30.0)
                except httpx.HTTPError:
                    pass

    def unload_all_sync(self) -> None:
        """Evict every loaded model from VRAM (used before the image model takes the GPU)."""
        base = str(self.http.base_url)
        with httpx.Client(base_url=base, timeout=30.0) as c:
            try:
                for m in c.get("/api/ps").json().get("models", []):
                    c.post("/api/generate", json={"model": m["name"], "keep_alive": 0})
            except httpx.HTTPError:
                pass  # Ollama down: nothing to unload


# --- fake ------------------------------------------------------------------

WORD = re.compile(r"[a-z0-9']+")
STOP = set("a an the and or of to in on for with about by is are was be me i my you your some any that this it"
           " books book novel novels read reading want like more please recommend give".split())


def _tokens(text: str) -> list[str]:
    return [w.rstrip("s") if len(w) > 3 else w for w in WORD.findall(text.lower()) if w not in STOP]


class FakeLLM:
    """Deterministic stand-in: hashed bag-of-words embeddings and template answers built from the prompt.

    Deliberately simple: no real language understanding — it only exists so tests and Playwright run without Ollama.
    """

    name = "fake"
    dims = 256

    def __init__(self, embed_model: str = "fake-embed", num_ctx: int = 8192):
        self.embed_model = embed_model
        self.num_ctx = num_ctx

    def _vector(self, text: str) -> list[float]:
        vec = [0.0] * self.dims
        for tok in _tokens(text.split("Query:", 1)[-1]):
            h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
            vec[h % self.dims] += 1.0 if (h >> 8) & 1 else -1.0
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec] if any(vec) else [1.0 / math.sqrt(self.dims)] * self.dims

    async def embed(self, texts: list[str], bulk: bool = False) -> tuple[list[list[float]], int]:
        return [self._vector(t) for t in texts], sum(len(t.split()) for t in texts)

    async def free_gpu_for_embedding(self) -> None:
        pass

    async def chat(self, model: str, messages: list[dict]) -> ChatResult:
        # Used for follow-up rewriting: join every "User:" line in the prompt into one query.
        prompt = messages[-1]["content"]
        users = re.findall(r"^(?:User|Follow-up): (.+)$", prompt, re.M)
        text = " ".join(users) or prompt
        return ChatResult(text, [], len(prompt.split()), len(text.split()))

    async def chat_stream(self, model: str, messages: list[dict], tools: list[dict] | None = None
                          ) -> AsyncIterator[str | ChatResult]:
        system = messages[0]["content"]
        books = re.findall(r'^\d+\. "(.+?)" by (.+?) —', system, re.M)
        if books:
            lines = ["Here are some picks from your library:", ""]
            lines += [f"**{title}** by {author} — a strong match for what you asked." for title, author in books[:3]]
            lines += ["", "Would you like something in a different mood?"]
        else:
            lines = ["I couldn't find a good match in your library for that. Try describing a theme, mood or genre."]
        content = "\n".join(lines)
        for word in re.split(r"(\s+)", content):
            if word:
                yield word
        prompt_tokens = sum(len(str(m.get("content", "")).split()) for m in messages)
        yield ChatResult(content, [], prompt_tokens, len(content.split()))

    async def is_up(self) -> bool:
        return True

    async def loaded_models(self) -> list[dict]:
        return []

    def unload_all_sync(self) -> None:
        pass
