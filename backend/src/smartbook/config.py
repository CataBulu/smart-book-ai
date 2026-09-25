"""Runtime settings, read from environment variables (and an optional backend/.env file)."""

import os
from dataclasses import dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
PROJECT_DIR = BACKEND_DIR.parent


def _load_dotenv(path: Path) -> None:
    """Minimal KEY=VALUE loader; real environment variables win."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _env(key: str, default: str) -> str:
    return os.environ.get(key, default)


def _flag(key: str, default: bool) -> bool:
    return _env(key, "1" if default else "0").lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    ollama_url: str
    chat_models: dict[str, str]
    embed_model: str
    embed_on_cpu: bool
    num_ctx: int
    relevance_max_distance: float
    moderation_threshold: float
    top_k_chunks: int
    max_books: int
    history_messages: int
    max_message_chars: int
    max_upload_mb: int
    fake_llm: bool
    autoseed: bool
    prices: dict[str, tuple[float, float]]
    host: str
    port: int

    def cost(self, model: str, prompt_tokens: int, completion_tokens: int) -> float:
        """Cloud-equivalent $ cost. Local inference is free; rates are configurable estimates."""
        price_in, price_out = self.prices.get(model, (0.0, 0.0))
        return (prompt_tokens * price_in + completion_tokens * price_out) / 1_000_000


def load_settings() -> Settings:
    _load_dotenv(BACKEND_DIR / ".env")
    pro = _env("SMARTBOOK_MODEL_PRO", "qwen3.5:4b")
    lite = _env("SMARTBOOK_MODEL_LITE", "qwen3.5:2b-q4_K_M")
    embed = _env("SMARTBOOK_MODEL_EMBED", "qwen3-embedding:0.6b")
    return Settings(
        data_dir=Path(_env("SMARTBOOK_DATA_DIR", str(BACKEND_DIR / ".data"))),
        ollama_url=_env("OLLAMA_URL", "http://127.0.0.1:11434"),
        chat_models={"pro": pro, "lite": lite},
        embed_model=embed,
        embed_on_cpu=_flag("SMARTBOOK_EMBED_ON_CPU", True),
        num_ctx=int(_env("SMARTBOOK_NUM_CTX", "8192")),
        relevance_max_distance=float(_env("SMARTBOOK_RELEVANCE_MAX_DISTANCE", "0.68")),
        moderation_threshold=float(_env("SMARTBOOK_MODERATION_THRESHOLD", "0.60")),
        top_k_chunks=int(_env("SMARTBOOK_TOP_K", "12")),
        max_books=int(_env("SMARTBOOK_MAX_BOOKS", "5")),
        history_messages=int(_env("SMARTBOOK_HISTORY_MESSAGES", "8")),
        max_message_chars=int(_env("SMARTBOOK_MAX_MESSAGE_CHARS", "2000")),
        max_upload_mb=int(_env("SMARTBOOK_MAX_UPLOAD_MB", "200")),
        fake_llm=_flag("SMARTBOOK_FAKE_LLM", False),
        autoseed=_flag("SMARTBOOK_AUTOSEED", True),
        prices={
            pro: (float(_env("SMARTBOOK_PRICE_PRO_IN", "0.10")), float(_env("SMARTBOOK_PRICE_PRO_OUT", "0.40"))),
            lite: (float(_env("SMARTBOOK_PRICE_LITE_IN", "0.05")), float(_env("SMARTBOOK_PRICE_LITE_OUT", "0.20"))),
            embed: (float(_env("SMARTBOOK_PRICE_EMBED_IN", "0.02")), 0.0),
        },
        host=_env("SMARTBOOK_HOST", "127.0.0.1"),
        port=int(_env("SMARTBOOK_PORT", "8000")),
    )
