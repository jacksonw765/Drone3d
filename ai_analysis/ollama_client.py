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
            return response.json()["response"]
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
    ) -> dict | list:
        """Request JSON-structured output from the model.

        Args:
            prompt: The analysis prompt
            schema_hint: Example JSON schema the model should follow
            model: Model override
            images: Optional base64 images for vision analysis

        Returns:
            Parsed JSON response (dict or list)
        """
        full_prompt = (
            f"{prompt}\n\n"
            f"Respond ONLY with valid JSON matching this schema:\n{schema_hint}\n"
            f"No explanation, no markdown, just the JSON object."
        )
        raw = self.generate(full_prompt, model=model, images=images)

        # Clean up common LLM formatting issues
        clean = raw.strip()
        if clean.startswith("```json"):
            clean = clean[7:]
        if clean.startswith("```"):
            clean = clean[3:]
        if clean.endswith("```"):
            clean = clean[:-3]
        clean = clean.strip()

        try:
            return json.loads(clean)
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse structured output: {e}\nRaw: {raw[:500]}")
            # Try to find JSON in the response
            for start_char, end_char in [("{", "}"), ("[", "]")]:
                start = clean.find(start_char)
                end = clean.rfind(end_char)
                if start != -1 and end != -1 and end > start:
                    try:
                        return json.loads(clean[start:end + 1])
                    except json.JSONDecodeError:
                        continue
            raise

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

    def close(self):
        """Close the HTTP client."""
        self.client.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
