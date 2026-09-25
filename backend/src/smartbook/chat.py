"""RAG chat pipeline → (event, data) pairs streamed to the browser as SSE.

moderation L0/L1 → embed query → moderation L2 → follow-up rewrite → retrieve (threshold) → prompt
→ streaming chat with function calling (search_library / get_book_details) → persist + usage.
"""

import json
from collections.abc import AsyncIterator

from .config import Settings
from .db import Store
from .library import Hit, Library
from .llm import ChatResult, LLMError
from .moderation import SemanticModerator, Verdict, check_rules
from .rewrite import build_prompt, clean, needs_rewrite

Event = tuple[str, dict]
MAX_TOOL_ROUNDS = 3

SYSTEM_PROMPT = """You are Smart Book AI, a warm, knowledgeable librarian. You recommend books ONLY from the user's \
Smart Book AI library.

Rules:
- Always write in English, even if the user writes in another language.
- Recommend only books listed in LIBRARY CONTEXT below or returned by your tools. Never invent titles, authors or \
plot details that are not in the provided data.
- If nothing fits, say so honestly and suggest how to rephrase, or which kind of book to add to the library.
- For each pick write the exact title in bold, then "by <author>", then one or two sentences on why it fits.
- Recommend 1 to 4 books, keep the answer under 180 words, and end with one short follow-up question.
- Call get_book_details when the user asks about a specific book in more depth. Call search_library only when \
the context does not cover the request, and only with different words than the search shown in LIBRARY CONTEXT.
- Only talk about books and reading; politely steer anything else back to books."""

TOOLS = [
    {"type": "function", "function": {
        "name": "search_library",
        "description": "Semantic search over the Smart Book AI library. Use it when LIBRARY CONTEXT does not "
                       "contain a good match or the user asks for something different.",
        "parameters": {"type": "object", "required": ["query"], "properties": {
            "query": {"type": "string", "description": "Themes, mood, genre or subject to search for, in English"},
            "limit": {"type": "integer", "description": "Maximum number of books to return (1-8)"},
        }},
    }},
    {"type": "function", "function": {
        "name": "get_book_details",
        "description": "Get the full stored summary, genres and themes of one library book by its title.",
        "parameters": {"type": "object", "required": ["title"], "properties": {
            "title": {"type": "string", "description": "The book title, as written in the library"},
        }},
    }},
]


def conversation_title(message: str) -> str:
    first = " ".join(message.split())
    return first if len(first) <= 48 else first[:47].rstrip() + "…"


class ChatService:
    def __init__(self, settings: Settings, store: Store, library: Library, moderator: SemanticModerator, llm):
        self.s = settings
        self.store = store
        self.library = library
        self.moderator = moderator
        self.llm = llm

    # --- helpers -----------------------------------------------------------
    def _record(self, session_id: str, conv_id: str, model: str, purpose: str, prompt: int, completion: int) -> float:
        cost = self.s.cost(model, prompt, completion)
        self.store.add_usage(session_id, conv_id, model, purpose, prompt, completion, cost)
        return cost

    def _sources(self, hits: list[Hit]) -> list[dict]:
        out = []
        for hit in hits:
            book = self.store.get_book(hit.book_id)
            if book:  # skip index entries whose book row vanished
                out.append({"book_id": book["id"], "title": book["title"], "author": book["author"],
                            "genres": book["genres"], "themes": book["themes"], "description": book["description"],
                            "score": hit.score, "kind": hit.kind, "snippet": hit.snippet})
        return out

    @staticmethod
    def _format_books(sources: list[dict]) -> str:
        lines = []
        for i, b in enumerate(sources, 1):
            lines.append(f'{i}. "{b["title"]}" by {b["author"]} — {", ".join(b["genres"]) or "Unclassified"}'
                         f' | themes: {", ".join(b["themes"]) or "n/a"} | relevance {b["score"]:.2f}')
            lines.append(f"   {b['description']}")
            if b["kind"] == "text":
                lines.append(f"   Matching excerpt: {' '.join(b['snippet'].split())[:500]}")
        return "\n".join(lines)

    def _context(self, query: str, sources: list[dict]) -> str:
        if not sources:
            return (f'LIBRARY CONTEXT (search: "{query}"): no library book passed the relevance threshold. '
                    "Try search_library with different words before concluding nothing fits.")
        return f'LIBRARY CONTEXT (search: "{query}", best matches first):\n' + self._format_books(sources)

    @staticmethod
    def _merge(sources: list[dict], new: list[dict]) -> list[dict]:
        seen = {s["book_id"] for s in sources}
        return sources + [s for s in new if s["book_id"] not in seen]

    async def _run_tool(self, name: str, args: dict, session_id: str, conv_id: str) -> tuple[str, list[dict]]:
        if name == "search_library":
            query = str(args.get("query", "")).strip()
            if not query:
                return "search_library needs a non-empty query.", []
            vector, tokens = await self.library.embed_query(query)
            self._record(session_id, conv_id, self.s.embed_model, "tool_embed", tokens, 0)
            limit = max(1, min(int(args.get("limit") or 4), 8))
            found = self._sources(self.library.search(vector, self.s.relevance_max_distance, self.s.top_k_chunks,
                                                      limit))
            return (self._format_books(found) if found else f'No library books matched "{query}".'), found
        if name == "get_book_details":
            book = self.store.find_book(str(args.get("title", "")))
            if not book:
                return f'No book titled "{args.get("title", "")}" is in the library.', []
            details = {k: book[k] for k in ("title", "author", "genres", "themes", "description")}
            source = {"book_id": book["id"], "title": book["title"], "author": book["author"],
                      "genres": book["genres"], "themes": book["themes"], "description": book["description"],
                      "score": None, "kind": "summary", "snippet": ""}
            return json.dumps(details, ensure_ascii=False), [source]
        return f"Unknown tool {name}.", []

    def _blocked(self, session_id: str, conv_id: str, message: str, verdict: Verdict) -> list[Event]:
        self.store.add_message(conv_id, "user", message, blocked=True)
        self.store.add_usage(session_id, conv_id, "moderation", "moderation_block", 0, 0, 0.0)
        msg_id = self.store.add_message(conv_id, "assistant", verdict.message, blocked=True)
        return [("blocked", {"layer": verdict.layer, "category": verdict.category, "message": verdict.message}),
                ("done", {"message_id": msg_id, "usage": {"prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0},
                          "context": {"used": 0, "max": self.s.num_ctx}, "cited": []})]

    # --- pipeline ----------------------------------------------------------
    async def run(self, session_id: str, message: str, model_key: str = "pro",
                  conversation_id: str | None = None) -> AsyncIterator[Event]:
        model = self.s.chat_models.get(model_key, self.s.chat_models["pro"])
        conv = self.store.get_conversation(conversation_id) if conversation_id else None
        conv = conv or self.store.create_conversation(conversation_title(message))
        cid = conv["id"]
        history = [m for m in self.store.messages(cid, limit=self.s.history_messages) if not m["blocked"]]
        yield "meta", {"conversation_id": cid, "title": conv["title"]}
        user_saved = False
        try:
            # L0 + L1: free, before any model call
            yield "status", {"stage": "moderating"}
            verdict = check_rules(message, self.s.max_message_chars)
            if not verdict.allowed:
                for event in self._blocked(session_id, cid, message, verdict):
                    yield event
                return

            # One embedding call feeds both L2 moderation and retrieval.
            vector, tokens = await self.library.embed_query(message)
            cost = self._record(session_id, cid, self.s.embed_model, "embed_query", tokens, 0)
            verdict, _ = await self.moderator.check(vector)
            if not verdict.allowed:
                for event in self._blocked(session_id, cid, message, verdict):
                    yield event
                return
            self.store.add_message(cid, "user", message)
            user_saved = True
            prompt_total, completion_total = tokens, 0

            query = message
            if needs_rewrite(message, history):
                yield "status", {"stage": "rewriting"}
                r = await self.llm.chat(model, build_prompt(message, history))
                cost += self._record(session_id, cid, model, "rewrite", r.prompt_tokens, r.completion_tokens)
                prompt_total += r.prompt_tokens
                completion_total += r.completion_tokens
                query = clean(r.content, message)
                if query != message:
                    yield "rewrite", {"query": query}
                    vector, tokens = await self.library.embed_query(query)
                    cost += self._record(session_id, cid, self.s.embed_model, "embed_rewrite", tokens, 0)
                    prompt_total += tokens

            yield "status", {"stage": "searching"}
            sources = self._sources(self.library.search(vector, self.s.relevance_max_distance,
                                                        self.s.top_k_chunks, self.s.max_books))
            yield "sources", {"books": sources}

            messages = [{"role": "system", "content": SYSTEM_PROMPT + "\n\n" + self._context(query, sources)}]
            messages += [{"role": m["role"], "content": m["content"]} for m in history]
            messages.append({"role": "user", "content": message})

            yield "status", {"stage": "generating"}
            answer, last = "", ChatResult()
            for round_ in range(MAX_TOOL_ROUNDS + 1):
                tools = TOOLS if round_ < MAX_TOOL_ROUNDS else None  # final round must answer in text
                async for piece in self.llm.chat_stream(model, messages, tools):
                    if isinstance(piece, ChatResult):
                        last = piece
                    else:
                        answer += piece
                        yield "token", {"text": piece}
                cost += self._record(session_id, cid, model, "chat", last.prompt_tokens, last.completion_tokens)
                prompt_total += last.prompt_tokens
                completion_total += last.completion_tokens
                if not last.tool_calls:
                    break
                messages.append({"role": "assistant", "content": last.content, "tool_calls": last.tool_calls})
                for call in last.tool_calls:
                    fn = call.get("function", {})
                    args = fn.get("arguments") or {}
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except json.JSONDecodeError:
                            args = {}
                    yield "tool", {"name": fn.get("name"), "args": args}
                    yield "status", {"stage": "tool", "detail": fn.get("name")}
                    output, found = await self._run_tool(fn.get("name", ""), args, session_id, cid)
                    if found:
                        sources = self._merge(sources, found)
                        yield "sources", {"books": sources}
                    messages.append({"role": "tool", "tool_name": fn.get("name", ""), "content": output})

            answer = answer.strip() or "Sorry, I couldn't put an answer together. Could you rephrase that?"
            cited = [s["book_id"] for s in sources if s["title"].lower() in answer.lower()]
            for s in sources:
                s["cited"] = s["book_id"] in cited
            msg_id = self.store.add_message(cid, "assistant", answer, sources=sources, prompt_tokens=prompt_total,
                                            completion_tokens=completion_total, cost=cost)
            yield "done", {"message_id": msg_id, "cited": cited,
                           "usage": {"prompt_tokens": prompt_total, "completion_tokens": completion_total,
                                     "cost": round(cost, 6)},
                           "context": {"used": last.prompt_tokens + last.completion_tokens, "max": self.s.num_ctx}}
        except LLMError as e:
            if not user_saved:
                self.store.add_message(cid, "user", message)
            yield "error", {"message": "The local Qwen model is not reachable. Make sure Ollama is running "
                                       f"(`ollama serve`) and the models are pulled. Details: {e}"}
