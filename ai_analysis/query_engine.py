"""
Natural Language Query Engine.

Enables operators to ask plain-language questions about a
reconstructed scene using the vision model with actual imagery.
"""

import base64
import io
import json
import logging
import os

logger = logging.getLogger("ai_analysis")


class SceneQueryEngine:
    """Natural language Q&A over Drone3D project data."""

    def __init__(self, client):
        self.client = client

    def _get_scene_images(self, project, max_size: int = 2048) -> list[str]:
        """Get a single base64 image of the scene for the vision model.

        Returns one image — the orthophoto (preferred) or a texture
        tile as fallback. Llama3.2-vision works best with a single image.
        """
        from django.conf import settings

        # 1. Try orthophoto first (best overview)
        if project.orthophoto_path:
            full_path = os.path.join(settings.MEDIA_ROOT, project.orthophoto_path)
            img_b64 = self._load_image(full_path, max_size)
            if img_b64:
                return [img_b64]

        # 2. Fall back to largest texture tile
        if project.mesh_path:
            mesh_dir = os.path.join(
                settings.MEDIA_ROOT,
                os.path.dirname(project.mesh_path),
            )
            if os.path.isdir(mesh_dir):
                textures = sorted([
                    f for f in os.listdir(mesh_dir)
                    if f.lower().endswith(('.png', '.jpg', '.jpeg'))
                    and 'map_Kd' in f
                ])
                if textures:
                    tex_b64 = self._load_image(
                        os.path.join(mesh_dir, textures[0]), max_size
                    )
                    if tex_b64:
                        return [tex_b64]

        return []

    def _load_image(self, path: str, max_size: int = 1536) -> str | None:
        """Load and resize an image to base64 JPEG for the vision model."""
        if not os.path.exists(path):
            return None
        try:
            from PIL import Image

            img = Image.open(path)
            img.thumbnail((max_size, max_size), Image.LANCZOS)
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")

            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=85)
            return base64.b64encode(buf.getvalue()).decode("utf-8")
        except Exception as e:
            logger.warning(f"Could not load image {path}: {e}")
            return None

    def query(self, project, question: str) -> dict:
        """Answer a question about a project's scene data."""
        # Build context from project annotations
        annotations = list(project.annotations.values(
            "label", "category", "latitude", "longitude",
            "altitude", "confidence", "source",
        ))

        by_category = {}
        for ann in annotations:
            cat = ann["category"]
            by_category.setdefault(cat, 0)
            by_category[cat] += 1

        # Get scene images
        scene_images = self._get_scene_images(project)
        has_images = len(scene_images) > 0

        if has_images:
            # Build a compact metadata block only if useful
            meta_parts = []
            if project.approx_latitude and project.approx_longitude:
                meta_parts.append(
                    f"Location: {project.approx_latitude}, {project.approx_longitude}"
                )
            if annotations:
                meta_parts.append(
                    f"Detected features: {json.dumps(by_category, default=str)}"
                )
            if project.ai_report:
                meta_parts.append(
                    f"Prior assessment: {project.ai_report[:1500]}"
                )

            metadata_block = "\n".join(meta_parts) if meta_parts else ""

            prompt = f"""You are an expert aerial imagery analyst. You are looking at high-resolution aerial photographs captured by a drone.

Question: "{question}"

Answer the question directly and specifically based on what you can see in the images. Be concise — no filler, no caveats about image quality. If you can identify specific species, materials, or features, name them. If you're uncertain, give your best assessment with a confidence qualifier.

{metadata_block}""".strip()
        else:
            context = {
                "project_name": project.name,
                "center_lat": project.approx_latitude,
                "center_lon": project.approx_longitude,
                "annotations": annotations[:50] if annotations else "none",
            }
            if project.ai_report:
                context["assessment"] = project.ai_report[:2000]

            prompt = f"""You are an expert geospatial analyst. Answer this question based on the available data:

Question: "{question}"

Data:
{json.dumps(context, indent=2, default=str)}

Answer directly and concisely. No imagery is available for this project."""

        try:
            health = self.client.health_check()
            if not health.get("available"):
                return {
                    "question": question,
                    "answer": "Ollama is not reachable. Please try again in a moment.",
                    "error": True,
                    "project_id": str(project.id),
                }

            models = health.get("models", [])
            if not models:
                return {
                    "question": question,
                    "answer": "No AI models loaded yet. The model may still be downloading.",
                    "error": True,
                    "project_id": str(project.id),
                }

            # Send all images (orthophoto + texture tiles) to the vision model
            images = scene_images if has_images else None
            answer = self.client.generate(prompt, images=images)

            return {
                "question": question,
                "answer": answer,
                "annotations_referenced": len(annotations),
                "images_analyzed": len(scene_images),
                "project_id": str(project.id),
                "categories_available": by_category,
            }
        except Exception as e:
            error_str = str(e)
            if "404" in error_str:
                msg = "AI model not available yet. Run: bash scripts/ollama-init.sh"
            elif "ConnectError" in error_str or "Connection" in error_str:
                msg = "Cannot connect to Ollama. Ensure the service is running."
            else:
                msg = f"Query failed: {error_str}"

            logger.error(f"Query failed: {e}")
            return {
                "question": question,
                "answer": msg,
                "error": True,
                "project_id": str(project.id),
            }

    def inspect_object(
        self,
        project,
        screenshot_b64: str | None = None,
        screenshots: list | None = None,
        bounding_box: dict = None,
        position: dict = None,
        info: dict | None = None,
        question: str | None = None,
        project_name: str | None = None,
    ) -> dict:
        """Inspect a specific selected object/region in the 3D scene.

        Args:
            project: DroneProject instance
            screenshot_b64: Single base64 screenshot (legacy fallback)
            screenshots: List of {angle: str, image_b64: str} multi-view screenshots
            bounding_box: Dict with width, height, depth
            position: Dict with x, y, z centroid
            info: Object metadata (category, label, triangleCount, etc.)
            question: User question
            project_name: Project name for context
        """
        info = info or {}
        bounding_box = bounding_box or {}
        position = position or {}
        screenshots = screenshots or []
        category = info.get("category", "unknown")
        label = info.get("label", "selected region")

        # Format dimensions
        def fmt_dim(v):
            if v is None:
                return "?"
            v = float(v)
            if v < 1:
                return f"{v * 100:.1f}cm"
            return f"{v:.2f}m"

        width = fmt_dim(bounding_box.get("width"))
        height = fmt_dim(bounding_box.get("height"))
        depth = fmt_dim(bounding_box.get("depth"))
        pos_str = f"({position.get('x', 0):.1f}, {position.get('y', 0):.1f}, {position.get('z', 0):.1f})"

        # Project context
        scene_name = project_name or project.name or "Unknown"
        scene_desc = getattr(project, "description", "") or ""

        # Get nearby annotations
        annotations = list(project.annotations.values(
            "label", "category", "latitude", "longitude",
            "altitude", "confidence",
        )[:10])

        nearby_context = ""
        if annotations:
            nearby_items = [f"- {a['label']} ({a['category']})" for a in annotations[:5]]
            nearby_context = "Known features in this scene:\n" + "\n".join(nearby_items)

        user_question = question or "What is this object? Describe it."

        # Build images list and view description for the prompt
        images = []
        view_description = ""

        if screenshots:
            # Multi-view mode — stitch into a single composite for models
            # that only support one image (e.g. llama3.2-vision)
            angles = [s.get("angle", f"view-{i}") for i, s in enumerate(screenshots)]
            raw_images = [s["image_b64"] for s in screenshots if s.get("image_b64")]

            if len(raw_images) > 1:
                # Stitch into 2×2 grid
                composite_b64 = self._stitch_images(raw_images)
                if composite_b64:
                    images = [composite_b64]
                else:
                    # Fallback to first image only
                    images = [raw_images[0]]
            elif raw_images:
                images = [raw_images[0]]

            view_description = (
                f"You are given a composite image showing {len(raw_images)} views of the selected object "
                f"arranged in a 2×2 grid from angles: {', '.join(angles)}. "
                f"Each view has a GREEN CROSSHAIR MARKER showing the selected object. "
                f"Use ALL views together to understand the object's full 3D shape, size, and context."
            )
        elif screenshot_b64:
            # Single screenshot fallback
            images = [screenshot_b64]
            view_description = (
                "The image shows the 3D scene with a GREEN CROSSHAIR MARKER indicating the selected object. "
                "Focus your analysis on the object at that crosshair."
            )

        if images:
            prompt = f"""You are analyzing a 3D drone reconstruction called "{scene_name}".
{f'Scene description: {scene_desc}' if scene_desc else ''}

{view_description}

OBJECT MEASUREMENTS (from 3D geometry analysis):
- Bounding box: {width} (W) × {height} (H) × {depth} (D)
- Geometry classifier guess: "{label}" (may be incorrect)
{f'- Contains {info["triangleCount"]:,} triangles' if info.get("triangleCount") else ''}
{f'- Contains ~{info["pointCount"]:,} points' if info.get("pointCount") else ''}

{nearby_context}

USER QUESTION: {user_question}

INSTRUCTIONS:
1. Using the provided view(s), describe what this object actually is
2. If it's a natural feature (tree, bush, terrain, snow), identify it correctly
3. Estimate its real-world size if possible
4. Do NOT fabricate details — only describe what you can see
5. Keep your answer to 3-5 sentences""".strip()

        else:
            prompt = f"""You are analyzing a 3D drone reconstruction called "{scene_name}".

No visual data available. Selected point measurements:
- Dimensions: {width} (W) × {height} (H) × {depth} (D)
- Position: {pos_str}
- Classifier guess: "{label}"

{nearby_context}

USER QUESTION: {user_question}

Provide analysis based on available data only. Be honest about limitations."""

            images = None

        try:
            health = self.client.health_check()
            if not health.get("available"):
                return {
                    "answer": "Ollama is not reachable. Please try again.",
                    "error": True,
                }

            answer = self.client.generate(prompt, images=images)

            return {
                "answer": answer,
                "object_info": {
                    "category": category,
                    "label": label,
                    "dimensions": {"width": width, "height": height, "depth": depth},
                    "position": pos_str,
                },
                "views_sent": len(images) if images else 0,
                "project_id": str(project.id),
            }
        except Exception as e:
            logger.error(f"Object inspection failed: {e}")
            return {
                "answer": f"Inspection failed: {str(e)}",
                "error": True,
            }
        finally:
            # Ensure HTTP client resources are released
            try:
                self.client.close()
            except Exception:
                pass

    @staticmethod
    def _stitch_images(b64_images: list, max_size: int = 1024) -> str:
        """Stitch multiple base64 images into a single 2×2 composite.

        Returns a base64-encoded JPEG of the composite, or None on failure.
        """
        import base64
        from io import BytesIO

        try:
            from PIL import Image
        except ImportError:
            logger.warning("Pillow not installed — cannot stitch multi-view images")
            return None

        try:
            pil_images = []
            for b64 in b64_images[:4]:  # max 4 images
                # Handle data URI prefix if present
                if "," in b64:
                    b64 = b64.split(",", 1)[1]
                img_data = base64.b64decode(b64)
                pil_images.append(Image.open(BytesIO(img_data)))

            if not pil_images:
                return None

            # Determine grid layout
            count = len(pil_images)
            if count == 1:
                composite = pil_images[0]
            elif count == 2:
                cols, rows = 2, 1
            else:
                cols, rows = 2, 2

            if count > 1:
                # Resize all to consistent size
                cell_w = max_size // cols
                cell_h = max_size // rows
                for i, img in enumerate(pil_images):
                    pil_images[i] = img.resize((cell_w, cell_h), Image.LANCZOS)

                composite = Image.new("RGB", (max_size, cell_h * rows), (0, 0, 0))
                for i, img in enumerate(pil_images):
                    x = (i % cols) * cell_w
                    y = (i // cols) * cell_h
                    composite.paste(img, (x, y))

            # Encode as JPEG
            buf = BytesIO()
            composite.save(buf, format="JPEG", quality=85)
            buf.seek(0)
            result = base64.b64encode(buf.read()).decode("utf-8")

            # Cleanup
            buf.close()
            for img in pil_images:
                img.close()

            logger.info(f"Stitched {count} views into {composite.size[0]}x{composite.size[1]} composite")
            return result

        except Exception as e:
            logger.error(f"Failed to stitch images: {e}")
            return None


