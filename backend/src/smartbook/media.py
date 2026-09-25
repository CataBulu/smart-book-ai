"""Local media models, all on CPU so the chat model keeps the GPU:

- ImageGenerator  stabilityai/sd-turbo (diffusers)   book covers + scene illustrations
- Transcriber     faster-whisper base.en             speech → text
- Speaker         Kokoro-82M (kokoro-onnx)           text → speech (WAV)

Each model is loaded lazily on first use and guarded by a lock (one job at a time per model).
`uv run python -m smartbook.media download` pre-fetches every model.
"""

import io
import os
import re
import struct
import threading
import wave
import zlib
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path

from .config import BACKEND_DIR

MODELS_DIR = Path(os.environ.get("SMARTBOOK_MODELS_DIR", BACKEND_DIR / ".models"))
SD_MODEL = "stabilityai/sd-turbo"
WHISPER_MODEL = "base.en"
KOKORO_FILES = {
    "kokoro-v1.0.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    "voices-v1.0.bin": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
}
VOICES = {"af_heart": "Heart (US, warm)", "af_bella": "Bella (US)", "am_michael": "Michael (US)",
          "bf_emma": "Emma (UK)", "bm_george": "George (UK)"}
DEFAULT_VOICE = "af_heart"
MAX_TTS_CHARS = 2500


class MediaUnavailable(RuntimeError):
    pass


def speakable(markdown: str) -> str:
    """Markdown → plain sentences for TTS."""
    text = re.sub(r"\[(.*?)\]\(.*?\)", r"\1", markdown)
    text = re.sub(r"[*_#`>|]+", "", text)
    text = re.sub(r"^\s*[-•]\s*", "", text, flags=re.M)
    return " ".join(text.split())[:MAX_TTS_CHARS]


def wav_bytes(samples, sample_rate: int) -> bytes:
    import numpy as np

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


_pipes: dict[str, object] = {}  # lives only inside the image worker process, keyed by device


def cuda_build() -> bool:
    """True when the installed torch is a CUDA build and an NVIDIA driver is present (checked without importing torch)."""
    import shutil
    from importlib.metadata import PackageNotFoundError, version

    try:
        return "+cu" in version("torch") and shutil.which("nvidia-smi") is not None
    except PackageNotFoundError:
        return False


def gpu_status() -> dict | None:
    """NVIDIA GPU name and VRAM via nvidia-smi (no CUDA context is created in this process)."""
    import shutil
    import subprocess

    if not shutil.which("nvidia-smi"):
        return None
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,memory.used,utilization.gpu",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5).stdout
        name, total, used, util = [x.strip() for x in out.splitlines()[0].split(",")]
        return {"name": name, "total_mb": int(total), "used_mb": int(used), "util_pct": int(util)}
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


def _load_pipeline(device: str = "cpu"):
    if device not in _pipes:
        try:
            import torch
            from diffusers import AutoPipelineForText2Image
        except ImportError as e:
            raise MediaUnavailable(f"image generation needs torch + diffusers: {e}") from e
        torch.set_num_threads(os.cpu_count() or 4)
        if device == "cuda":
            # GTX 16xx: fp16 UNet on the GPU (cuDNN off — its fp16 convs return NaN on Turing GTX), fp32 VAE on the
            # GPU with cuDNN (fp32 is fine), CLIP text encoder on the CPU in fp32. Peak ~2.7 GB VRAM, ~3.5 s/image.
            pipe = AutoPipelineForText2Image.from_pretrained(
                SD_MODEL, variant="fp16", torch_dtype=torch.float16, cache_dir=MODELS_DIR / "hf")
            encoder, vae = pipe.text_encoder.to(torch.float32), pipe.vae.to("cuda", torch.float32)
            pipe.text_encoder = pipe.vae = None
            pipe.unet.to("cuda")
            pipe.set_progress_bar_config(disable=True)
            _pipes[device] = (pipe, encoder, vae)
        else:
            # fp16 weights download (~2.6 GB) upcast to fp32: CPUs have no fast fp16 path.
            pipe = AutoPipelineForText2Image.from_pretrained(
                SD_MODEL, variant="fp16", torch_dtype=torch.float32, cache_dir=MODELS_DIR / "hf")
            pipe.set_progress_bar_config(disable=True)
            _pipes[device] = pipe
    return _pipes[device]


def _render(prompt: str, width: int, height: int, seed: int, steps: int, device: str = "cpu") -> bytes:
    import torch
    from PIL import Image

    if device == "cuda":
        pipe, encoder, vae = _load_pipeline("cuda")
        ids = pipe.tokenizer(prompt, padding="max_length", max_length=pipe.tokenizer.model_max_length,
                             truncation=True, return_tensors="pt").input_ids
        with torch.no_grad():
            embeds = encoder(ids)[0].to("cuda", torch.float16)
        torch.backends.cudnn.enabled = False
        latents = pipe(prompt_embeds=embeds, num_inference_steps=steps, guidance_scale=0.0, width=width, height=height,
                       output_type="latent", generator=torch.Generator("cuda").manual_seed(seed)).images
        torch.backends.cudnn.enabled = True
        with torch.no_grad():
            pixels = vae.decode(latents.float() / vae.config.scaling_factor).sample[0]
        image = Image.fromarray(((pixels.clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 0).cpu().numpy())
    else:
        image = _load_pipeline("cpu")(prompt=prompt, num_inference_steps=steps, guidance_scale=0.0, width=width,
                                      height=height, generator=torch.Generator().manual_seed(seed)).images[0]
    buf = io.BytesIO()
    image.save(buf, "WEBP", quality=88)
    return buf.getvalue()


class ImageGenerator:
    """SD-Turbo runs in a worker process that exits when idle, so its memory always goes back to the OS
    (torch never returns freed RAM, and on a 16 GB PC a resident 5 GB CPU pipeline starved Ollama).

    device "gpu": ~3.5 s/image, ~2.2 GB RAM, ~2.7 GB VRAM — `before_gpu` unloads the chat model first, and
    `release()` is called before every chat turn so the chat model gets the whole GPU back.
    device "cpu": ~20 s/image, ~6 GB RAM, no VRAM.
    """

    ext = "webp"

    def __init__(self, steps: int = 2, idle_unload_s: float = 90.0, device: str = "gpu", before_gpu=None):
        self.steps = steps
        self.idle_unload_s = idle_unload_s
        self.device = device
        self.before_gpu = before_gpu
        self._pool: ProcessPoolExecutor | None = None
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()

    @property
    def effective_device(self) -> str:
        return "gpu" if self.device == "gpu" and cuda_build() else "cpu"

    def release(self) -> None:
        """Stop the worker now (frees its RAM and VRAM). Safe to call anytime."""
        if self._pool is None:
            return
        with self._lock:
            if self._timer:
                self._timer.cancel()
            if self._pool:
                self._pool.shutdown(wait=False, cancel_futures=True)
                self._pool = None

    def set_device(self, device: str) -> None:
        self.release()
        self.device = device

    def generate(self, prompt: str, width: int, height: int, seed: int) -> bytes:
        gpu = self.effective_device == "gpu"
        if gpu and self.before_gpu:
            self.before_gpu()
        with self._lock:
            if self._timer:
                self._timer.cancel()
            self._pool = self._pool or ProcessPoolExecutor(max_workers=1)
            try:
                return self._pool.submit(_render, prompt, width, height, seed, self.steps,
                                         "cuda" if gpu else "cpu").result()
            except BrokenProcessPool as e:
                self._pool = None
                raise MediaUnavailable("the image worker crashed (out of memory?) — try again") from e
            finally:
                self._timer = threading.Timer(self.idle_unload_s, self.release)
                self._timer.daemon = True
                self._timer.start()


class Transcriber:
    def __init__(self):
        self._model = None
        self._lock = threading.Lock()

    def _load(self):
        if self._model is None:
            try:
                from faster_whisper import WhisperModel
            except ImportError as e:
                raise MediaUnavailable(f"speech-to-text needs faster-whisper: {e}") from e
            self._model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8",
                                       download_root=str(MODELS_DIR / "whisper"))
        return self._model

    def transcribe(self, audio: bytes) -> str:
        with self._lock:
            segments, _ = self._load().transcribe(io.BytesIO(audio), language="en", beam_size=1, vad_filter=True)
            return " ".join(s.text.strip() for s in segments).strip()


class Speaker:
    def __init__(self):
        self._kokoro = None
        self._lock = threading.Lock()

    def _load(self):
        if self._kokoro is None:
            try:
                from kokoro_onnx import Kokoro
            except ImportError as e:
                raise MediaUnavailable(f"text-to-speech needs kokoro-onnx: {e}") from e
            paths = [MODELS_DIR / "kokoro" / name for name in KOKORO_FILES]
            if not all(p.is_file() for p in paths):
                raise MediaUnavailable("Kokoro model files missing — run `uv run python -m smartbook.media download`")
            self._kokoro = Kokoro(str(paths[0]), str(paths[1]))
        return self._kokoro

    def speak(self, text: str, voice: str = DEFAULT_VOICE) -> bytes:
        with self._lock:
            samples, rate = self._load().create(speakable(text), voice=voice if voice in VOICES else DEFAULT_VOICE,
                                                speed=1.0, lang="en-us")
        return wav_bytes(samples, rate)


# --- fakes (tests / Playwright) --------------------------------------------

def tiny_png(rgb: tuple[int, int, int] = (37, 99, 235)) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00" + bytes(rgb))) + chunk(b"IEND", b""))


class FakeImageGenerator:
    ext = "png"
    device = "gpu"
    effective_device = "cpu"

    def release(self) -> None:
        pass

    def set_device(self, device: str) -> None:
        self.device = device

    def generate(self, prompt: str, width: int, height: int, seed: int) -> bytes:
        return tiny_png()


class FakeTranscriber:
    def transcribe(self, audio: bytes) -> str:
        return "books about the sea" if audio else ""


class FakeSpeaker:
    def speak(self, text: str, voice: str = DEFAULT_VOICE) -> bytes:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(8000)
            w.writeframes(b"\x00\x00" * 800)
        return buf.getvalue()


# --- download command ---------------------------------------------------------

def download() -> None:
    import httpx

    target = MODELS_DIR / "kokoro"
    target.mkdir(parents=True, exist_ok=True)
    for name, url in KOKORO_FILES.items():
        path = target / name
        if path.is_file():
            continue
        print(f"Downloading {name} …")
        with httpx.stream("GET", url, follow_redirects=True, timeout=600) as r:
            r.raise_for_status()
            with open(path.with_suffix(".part"), "wb") as f:
                for block in r.iter_bytes(1 << 20):
                    f.write(block)
        path.with_suffix(".part").rename(path)
    print("Loading Whisper (downloads on first run) …")
    Transcriber()._load()
    print("Loading SD-Turbo (downloads ~2.6 GB on first run) …")
    _load_pipeline("cpu")
    print(f"All media models ready in {MODELS_DIR}")


if __name__ == "__main__":
    import sys

    if sys.argv[1:] == ["download"]:
        download()
    else:
        print("usage: python -m smartbook.media download")


# --- prompts --------------------------------------------------------------------

def _mood(book: dict) -> str:
    genres = ", ".join(book.get("genres", [])[:2]).lower() or "literary"
    themes = ", ".join(book.get("themes", [])[:3]) or "the human condition"
    return f"{genres} book about {themes}"


def _first_sentence(text: str) -> str:
    return re.split(r"(?<=[.!?])\s", " ".join(text.split()), maxsplit=1)[0][:220]


COVER_MAX = (768, 1024)
COVER_FORMATS = {"JPEG", "PNG", "WEBP", "GIF", "BMP"}


def cover_from_upload(data: bytes) -> bytes:
    """A picture the reader chose as a cover: checked, turned upright, shrunk to fit 768x1024 and re-encoded as WebP,
    so only a clean image of ours is ever served (never the uploaded bytes)."""
    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.format not in COVER_FORMATS:
                raise ValueError(f"{im.format} pictures aren't supported")
            im.draft("RGB", COVER_MAX)  # JPEGs decode straight at a smaller size
            im = ImageOps.exif_transpose(im)
            im.thumbnail(COVER_MAX)
            if im.mode in ("RGBA", "LA", "P"):  # transparent parts become cover paper, not black
                im = im.convert("RGBA")
                flat = Image.new("RGB", im.size, (248, 247, 240))
                flat.paste(im, mask=im.getchannel("A"))
                im = flat
            out = io.BytesIO()
            im.convert("RGB").save(out, "WEBP", quality=88)
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as e:
        raise ValueError("That file isn't a picture Smart Book can use — choose a JPEG, PNG or WebP image.") from e
    return out.getvalue()


def cover_prompt(book: dict) -> str:
    return (f"Elegant minimalist book cover artwork for a {_mood(book)}. {_first_sentence(book['description'])} "
            "Painterly, atmospheric, muted blue palette, soft cinematic light, centered composition, no text")


def scene_prompt(book: dict) -> str:
    return (f"Atmospheric illustration of a scene from a {_mood(book)}. {_first_sentence(book['description'])} "
            "Detailed painterly style, warm light, wide shot, no text")


def available() -> dict[str, bool]:
    from importlib.util import find_spec

    return {"images": bool(find_spec("diffusers") and find_spec("torch")),
            "stt": bool(find_spec("faster_whisper")),
            "tts": bool(find_spec("kokoro_onnx")) and all((MODELS_DIR / "kokoro" / n).is_file() for n in KOKORO_FILES)}
