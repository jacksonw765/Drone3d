"""
Ollama LLM Client for Drone3D.

Wraps the Ollama REST API for text generation, image analysis
(vision models), and structured JSON output.

Supports GPU-accelerated inference (NVIDIA/CUDA), CPU fallback,
and Apple Silicon MLX when running Ollama natively.

Configuration via Django settings:
  - OLLAMA_HOST: API endpoint (default: http://localhost:11434)
  - OLLAMA_PRIMARY_MODEL: Vision model for image analysis
  - OLLAMA_TEXT_MODEL: Text model for reports and queries
"""

import base64
import json
import logging

import httpx

logger = logging.getLogger("ai_analysis")


class OllamaClient:
    """Client for the Ollama REST API."""

    def __init__(self, base_url: str = None, timeout: float = 300.0):
        from django.conf import settings
        self.base_url = base_url or getattr(settings, "OLLAMA_HOST", "http://localhost:11434")
        self.primary_model = getattr(settings, "OLLAMA_PRIMARY_MODEL", "llama3.2-vision:11b")
        self.text_model = getattr(settings, "OLLAMA_TEXT_MODEL", "llama3.2-vision:11b")
        self.client = httpx.Client(timeout=timeout)

    def generate(
        self,
        prompt: str,
        model: str = None,
        images: list[str] = None,
        stream: bool = False,
        temperature: float = 0.2,
        max_tokens: int = 4096,
    ) -> str:
        """Generate a text completion.

        Args:
            prompt: The text prompt
            model: Model name override (uses configured default if None)
            images: List of base64-encoded image strings (triggers vision model)
            stream: Whether to stream the response
            temperature: Sampling temperature (lower = more deterministic)
            max_tokens: Maximum tokens to generate

        Returns:
            Generated text response
        """
        # Auto-select vision model if images are provided
        if model is None:
            model = self.primary_model if images else self.text_model

        payload = {
            "model": model,
            "prompt": prompt,
            "stream": stream,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
                "repeat_penalty": 1.5,
                "repeat_last_n": 128,
            },
        }
        if images:
            payload["images"] = images

        try:
            response = self.client.post(
                f"{self.base_url}/api/generate",
                json=payload,
            )
            response.raise_for_status()
            raw = response.json()["response"]
            return self._trim_repetition(raw)
        except httpx.HTTPStatusError as e:
            logger.error(f"Ollama API error: {e.response.status_code} - {e.response.text}")
            raise
        except httpx.ConnectError:
            logger.error(f"Cannot connect to Ollama at {self.base_url}")
            raise

    def analyze_image(self, image_path: str, prompt: str) -> str:
        """Analyze a single image with the vision model.

        Args:
            image_path: Path to the image file
            prompt: Analysis prompt

        Returns:
            Vision model's text response
        """
        with open(image_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("utf-8")
        return self.generate(prompt=prompt, images=[b64])

    def analyze_image_bytes(self, image_bytes: bytes, prompt: str) -> str:
        """Analyze image from raw bytes."""
        b64 = base64.b64encode(image_bytes).decode("utf-8")
        return self.generate(prompt=prompt, images=[b64])

    def structured_output(
        self,
        prompt: str,
        schema_hint: str,
        model: str = None,
        images: list[str] = None,
        max_tokens: int = 1024,
    ) -> dict | list:
        """Request JSON-structured output from the model.

        Args:
            prompt: The analysis prompt
            schema_hint: Example JSON schema the model should follow
            model: Model override
            images: Optional base64 images for vision analysis
            max_tokens: Max tokens for generation (keep low for structured output)

        Returns:
            Parsed JSON response (dict or list)
        """
        import re

        full_prompt = (
            f"{prompt}\n\n"
            f"Respond ONLY with valid JSON matching this schema:\n{schema_hint}\n"
            f"No explanation, no markdown, just the JSON object."
        )
        raw = self.generate(full_prompt, model=model, images=images, max_tokens=max_tokens)

        # ── Sanitize control characters ──
        # LLMs often emit newlines/tabs inside JSON string values
        clean = raw.strip()

        # Remove markdown code fences
        if clean.startswith("```json"):
            clean = clean[7:]
        if clean.startswith("```"):
            clean = clean[3:]
        if clean.endswith("```"):
            clean = clean[:-3]
        clean = clean.strip()

        # Replace control characters (except newline) with space
        # then replace actual newlines within string values
        clean = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', ' ', clean)

        # Try direct parse first
        try:
            return json.loads(clean)
        except json.JSONDecodeError:
            pass

        # ── Handle concatenated JSON arrays ──
        # Model sometimes outputs multiple arrays:
        #   [{"a":1}]\n\n[{"b":2}]\n\n[{"c":3}]
        # Merge them into a single array
        arrays = []
        for match in re.finditer(r'\[.*?\]', clean, re.DOTALL):
            fragment = match.group()
            # Clean newlines inside string values by collapsing
            fragment = re.sub(r'(?<=")[^"]*(?=")', lambda m: m.group().replace('\n', ' '), fragment)
            try:
                parsed = json.loads(fragment)
                if isinstance(parsed, list):
                    arrays.extend(parsed)
            except json.JSONDecodeError:
                continue
        if arrays:
            return arrays

        # ── Last resort: find first valid JSON block ──
        for start_char, end_char in [("[", "]"), ("{", "}")]:
            start = clean.find(start_char)
            end = clean.rfind(end_char)
            if start != -1 and end != -1 and end > start:
                fragment = clean[start:end + 1]
                # Collapse newlines inside strings
                fragment = re.sub(r'(?<=")[^"]*(?=")', lambda m: m.group().replace('\n', ' '), fragment)
                try:
                    return json.loads(fragment)
                except json.JSONDecodeError:
                    continue

        logger.warning(f"Failed to parse structured output after all cleanup.\nRaw: {raw[:500]}")
        return []

    @staticmethod
    def _trim_repetition(text: str, min_phrase_len: int = 12, max_repeats: int = 2) -> str:
        """Detect and remove repetitive loops from LLM output.

        Scans for any phrase (of at least `min_phrase_len` characters) that
        repeats more than `max_repeats` times in a row, and truncates the
        output at the end of the allowed repetitions.
        """
        if not text or len(text) < min_phrase_len * 3:
            return text

        lines = text.split("\n")
        seen_lines = []
        consecutive = 0
        prev_line = None

        for line in lines:
            stripped = line.strip()
            if stripped == prev_line and stripped:
                consecutive += 1
                if consecutive >= max_repeats:
                    continue
            else:
                consecutive = 0
                prev_line = stripped
            seen_lines.append(line)

        result = "\n".join(seen_lines)

        # Also catch inline repetition (same sentence fragment repeated
        # on one line or across joined text without newlines)
        import re
        # Match any phrase >= min_phrase_len chars repeated 3+ times consecutively
        pattern = re.compile(
            r'(.{' + str(min_phrase_len) + r',}?)\1{2,}',
            re.DOTALL,
        )
        match = pattern.search(result)
        if match:
            result = result[:match.start()] + match.group(1)

        return result.rstrip()

    def health_check(self) -> dict:
        """Check Ollama API health and return status info.

        Returns:
            Dict with keys: available, models, gpu_info
        """
        try:
            r = self.client.get(f"{self.base_url}/api/tags")
            if r.status_code == 200:
                data = r.json()
                models = [m["name"] for m in data.get("models", [])]
                return {
                    "available": True,
                    "models": models,
                    "endpoint": self.base_url,
                }
            return {"available": False, "error": f"Status {r.status_code}"}
        except Exception as e:
            return {"available": False, "error": str(e)}

    def ensure_model(self, model: str = None) -> bool:
        """Check if a model is available, pull if not.

        Returns True if model is ready for use.
        """
        model = model or self.primary_model
        health = self.health_check()
        if not health["available"]:
            return False

        if model in health.get("models", []):
            return True

        # Try to pull the model
        logger.info(f"Model {model} not found, attempting to pull...")
        try:
            r = self.client.post(
                f"{self.base_url}/api/pull",
                json={"name": model},
                timeout=3600.0,
            )
            return r.status_code == 200
        except Exception as e:
            logger.error(f"Failed to pull model {model}: {e}")
            return False

    def unload_model(self, model: str = None):
        """Explicitly unload a model from Ollama's memory.

        Sends a generate request with keep_alive=0 which tells Ollama
        to immediately release the model from RAM. This is critical for
        the Drone3D pipeline where NodeODM and Ollama compete for memory.
        """
        model = model or self.primary_model
        try:
            self.client.post(
                f"{self.base_url}/api/generate",
                json={"model": model, "prompt": "", "keep_alive": 0},
                timeout=30,
            )
            logger.info(f"Unloaded model {model} from memory")
        except Exception as e:
            logger.warning(f"Failed to unload model {model}: {e}")

    def unload_all_models(self):
        """Unload ALL currently loaded models from Ollama's memory."""
        try:
            resp = self.client.get(f"{self.base_url}/api/ps", timeout=10)
            if resp.status_code == 200:
                loaded = resp.json().get("models", [])
                for m in loaded:
                    name = m.get("name") or m.get("model")
                    if name:
                        self.unload_model(name)
                if loaded:
                    logger.info(f"Unloaded {len(loaded)} model(s) from memory")
        except Exception as e:
            logger.warning(f"Failed to enumerate loaded models: {e}")

    def close(self):
        """Close the HTTP client."""
        self.client.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
