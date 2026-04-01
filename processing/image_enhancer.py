"""
Drone3D — AI Image Enhancement Pipeline.

Two-tier system for improving input image quality before photogrammetry:

Tier 1 (Standard): Luminance CLAHE · Gentle white balance · Unsharp mask · Denoise
    - Uses Pillow + NumPy (no extra dependencies)
    - ~0.3–0.5s per image on CPU
    - Preserves natural colors by operating in LAB color space for contrast

Tier 2 (Super Resolution): Real-ESRGAN 2× upscaling via ONNX Runtime
    - Dramatically increases detail for low-res video frames
    - ~2–5s per 1080p image on CPU
    - Only applied to images below a resolution threshold
    - NO double-enhancement — only mild sharpening post-upscale
"""

import io
import logging
import os
from typing import Callable, Optional

import numpy as np
from PIL import Image, ImageFilter, ImageEnhance

logger = logging.getLogger("processing")

# ── Configuration ──────────────────────────────────────────

# CLAHE grid size (tiles) — larger = more local contrast
CLAHE_GRID_SIZE = 8
# CLAHE clip limit — lower = more natural, higher = more dramatic
CLAHE_CLIP_LIMIT = 1.5  # reduced from 2.5 to preserve natural look

# Unsharp mask parameters
UNSHARP_RADIUS = 1.5     # reduced from 2.0
UNSHARP_PERCENT = 80     # reduced from 120
UNSHARP_THRESHOLD = 3    # only sharpen edges above this diff

# White balance blend factor: 0 = no correction, 1 = full gray-world
WHITE_BALANCE_STRENGTH = 0.4

# Dynamic range blend factor: 0 = no stretch, 1 = full stretch
DYNAMIC_RANGE_STRENGTH = 0.6

# Final blend: mix enhanced with original to anchor natural colors
# 0 = all original, 1 = all enhanced
ENHANCE_BLEND_FACTOR = 0.75

# Super-res threshold: only upscale images below this width
SUPER_RES_THRESHOLD = 3840  # Don't upscale 4K+ images


class ImageEnhancer:
    """Multi-tier image enhancement pipeline for drone imagery."""

    def __init__(self):
        self._onnx_session = None
        self._onnx_available = None

    # ── Tier 1: Standard Enhancement ─────────────────────

    @staticmethod
    def enhance_standard(image_path: str, output_path: str | None = None) -> str:
        """Apply the standard enhancement pipeline to a single image.

        Steps:
            1. CLAHE on luminance only (LAB space — preserves colors)
            2. Gentle white balance (blended, not full correction)
            3. Soft dynamic range optimization (blended)
            4. Unsharp mask sharpening
            5. Mild noise reduction
            6. Blend result with original to anchor natural colors

        EXIF metadata is fully preserved.

        Args:
            image_path: Path to the input image.
            output_path: Path for enhanced output. If None, generates
                         a path based on the input filename.

        Returns:
            Path to the enhanced image.
        """
        if output_path is None:
            base, ext = os.path.splitext(image_path)
            output_path = f"{base}_enhanced{ext}"

        try:
            # Load image
            img = Image.open(image_path)

            # Preserve EXIF data
            exif_data = None
            try:
                exif_data = img.info.get("exif")
            except Exception:
                pass

            # Convert to RGB for processing
            if img.mode != "RGB":
                img = img.convert("RGB")

            # Keep a copy of original for final blending
            original_arr = np.array(img, dtype=np.float32)
            arr = original_arr.copy()

            # Step 1: CLAHE on luminance only (preserves color channels)
            arr = _apply_clahe_luminance(arr)

            # Step 2: Gentle white balance (blended with original)
            arr = _auto_white_balance(arr, strength=WHITE_BALANCE_STRENGTH)

            # Step 3: Soft dynamic range stretch (blended)
            arr = _stretch_dynamic_range(arr, strength=DYNAMIC_RANGE_STRENGTH)

            # Convert back to PIL for remaining steps
            arr = np.clip(arr, 0, 255).astype(np.uint8)
            img = Image.fromarray(arr)

            # Step 4: Unsharp Mask (PIL-native, fast)
            img = img.filter(ImageFilter.UnsharpMask(
                radius=UNSHARP_RADIUS,
                percent=UNSHARP_PERCENT,
                threshold=UNSHARP_THRESHOLD,
            ))

            # Step 5: Mild noise reduction via smooth + blend
            smooth = img.filter(ImageFilter.GaussianBlur(radius=1))
            img = Image.blend(img, smooth, alpha=0.12)

            # Step 6: Very subtle contrast boost
            enhancer = ImageEnhance.Contrast(img)
            img = enhancer.enhance(1.03)  # reduced from 1.08

            # Step 7: Blend enhanced result with original to preserve natural colors
            enhanced_arr = np.array(img, dtype=np.float32)
            blended = (
                ENHANCE_BLEND_FACTOR * enhanced_arr
                + (1.0 - ENHANCE_BLEND_FACTOR) * original_arr
            )
            img = Image.fromarray(np.clip(blended, 0, 255).astype(np.uint8))

            # Save with preserved EXIF
            save_kwargs = {"quality": 95}
            if exif_data:
                save_kwargs["exif"] = exif_data

            img.save(output_path, **save_kwargs)
            return output_path

        except Exception as e:
            logger.error(f"Enhancement failed for {image_path}: {e}")
            # On failure, just copy the original
            if output_path != image_path:
                import shutil
                shutil.copy2(image_path, output_path)
            return output_path

    # ── Tier 2: Super Resolution ─────────────────────────

    def enhance_super_res(
        self, image_path: str, output_path: str | None = None
    ) -> str:
        """Apply Real-ESRGAN 2× super-resolution via ONNX Runtime.

        Only upscales images below SUPER_RES_THRESHOLD width.
        Falls back to standard enhancement if ONNX is unavailable
        or the image is already high-resolution.

        Args:
            image_path: Path to the input image.
            output_path: Path for enhanced output.

        Returns:
            Path to the enhanced/upscaled image.
        """
        if output_path is None:
            base, ext = os.path.splitext(image_path)
            output_path = f"{base}_enhanced{ext}"

        # Check if the image would benefit from super-resolution
        try:
            with Image.open(image_path) as img:
                width = img.width
        except Exception:
            return self.enhance_standard(image_path, output_path)

        if width >= SUPER_RES_THRESHOLD:
            logger.info(
                f"Image {os.path.basename(image_path)} is {width}px wide — "
                f"skipping super-res (threshold={SUPER_RES_THRESHOLD}px)"
            )
            return self.enhance_standard(image_path, output_path)

        # Try ONNX super-resolution
        session = self._get_onnx_session()
        if session is None:
            logger.info("ONNX Runtime unavailable — falling back to standard enhancement")
            return self.enhance_standard(image_path, output_path)

        try:
            return self._run_super_res(session, image_path, output_path)
        except Exception as e:
            logger.error(f"Super-resolution failed for {image_path}: {e}")
            return self.enhance_standard(image_path, output_path)

    def _get_onnx_session(self):
        """Lazily initialize the ONNX Runtime session."""
        if self._onnx_available is False:
            return None

        if self._onnx_session is not None:
            return self._onnx_session

        try:
            import onnxruntime as ort

            model_path = self._find_model()
            if not model_path:
                logger.warning("Real-ESRGAN ONNX model not found")
                self._onnx_available = False
                return None

            self._onnx_session = ort.InferenceSession(
                model_path,
                providers=["CPUExecutionProvider"],
            )
            self._onnx_available = True
            logger.info(f"Loaded Real-ESRGAN model from {model_path}")
            return self._onnx_session

        except ImportError:
            logger.warning("onnxruntime not installed — super-resolution unavailable")
            self._onnx_available = False
            return None
        except Exception as e:
            logger.error(f"Failed to load ONNX session: {e}")
            self._onnx_available = False
            return None

    @staticmethod
    def _find_model() -> str | None:
        """Locate the Real-ESRGAN ONNX model file."""
        candidates = [
            "/app/models/realesrgan-x2plus.onnx",
            os.path.join(os.path.dirname(__file__), "models", "realesrgan-x2plus.onnx"),
            os.path.expanduser("~/.cache/drone3d/realesrgan-x2plus.onnx"),
        ]
        for path in candidates:
            if os.path.isfile(path):
                return path
        return None

    def _run_super_res(self, session, image_path: str, output_path: str) -> str:
        """Execute Real-ESRGAN inference on an image.

        Processes the image in tiles (if large) to limit memory usage.
        The model upscales 2× — a 1920×1080 image becomes 3840×2160.

        NOTE: Does NOT re-apply CLAHE/white-balance after upscaling.
        The neural network's output already has good contrast and color.
        Only mild sharpening is applied post-upscale.
        """
        img = Image.open(image_path)

        # Preserve EXIF
        exif_data = None
        try:
            exif_data = img.info.get("exif")
        except Exception:
            pass

        if img.mode != "RGB":
            img = img.convert("RGB")

        # For images larger than ~1080p, process in tiles to limit RAM
        w, h = img.size
        tile_size = 512
        scale = 2

        if w * h > 2_100_000:  # > ~1080p
            # Tile-based processing
            result = Image.new("RGB", (w * scale, h * scale))

            for y in range(0, h, tile_size):
                for x in range(0, w, tile_size):
                    # Extract tile with overlap
                    overlap = 16
                    x1 = max(0, x - overlap)
                    y1 = max(0, y - overlap)
                    x2 = min(w, x + tile_size + overlap)
                    y2 = min(h, y + tile_size + overlap)

                    tile = img.crop((x1, y1, x2, y2))
                    upscaled = self._infer_tile(session, tile)

                    # Paste into result (trimming overlap)
                    ox = (x - x1) * scale
                    oy = (y - y1) * scale
                    tw = min(tile_size, w - x) * scale
                    th = min(tile_size, h - y) * scale
                    crop_region = upscaled.crop((ox, oy, ox + tw, oy + th))
                    result.paste(crop_region, (x * scale, y * scale))
        else:
            result = self._infer_tile(session, img)

        # Only mild sharpening post-upscale — no CLAHE/white-balance
        # The neural network output already preserves natural colors
        result = result.filter(ImageFilter.UnsharpMask(
            radius=1.0, percent=50, threshold=3
        ))

        # Save with EXIF preserved
        save_kwargs = {"quality": 95}
        if exif_data:
            save_kwargs["exif"] = exif_data

        result.save(output_path, **save_kwargs)
        logger.info(
            f"Super-res: {w}×{h} → {result.width}×{result.height} "
            f"({os.path.basename(image_path)})"
        )
        return output_path

    def _infer_tile(self, session, tile_img: Image.Image) -> Image.Image:
        """Run Real-ESRGAN inference on a single tile."""
        arr = np.array(tile_img, dtype=np.float32) / 255.0
        # ONNX expects NCHW format
        arr = arr.transpose(2, 0, 1)  # HWC → CHW
        arr = np.expand_dims(arr, axis=0)  # Add batch dim

        input_name = session.get_inputs()[0].name
        output = session.run(None, {input_name: arr})[0]

        # Output: NCHW → HWC
        output = output.squeeze(0).transpose(1, 2, 0)  # CHW → HWC
        output = np.clip(output * 255.0, 0, 255).astype(np.uint8)

        return Image.fromarray(output)

    # ── Batch Processing ─────────────────────────────────

    def enhance_batch(
        self,
        image_paths: list[str],
        mode: str = "standard",
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
    ) -> list[str]:
        """Enhance a batch of images with progress reporting.

        Args:
            image_paths: List of input image paths.
            mode: "standard" (Tier 1 only) or "super_res" (Tier 1 + Tier 2).
            progress_callback: Called with (current, total, filename) after each image.

        Returns:
            List of paths to enhanced images.
        """
        total = len(image_paths)
        enhanced_paths = []

        for i, path in enumerate(image_paths):
            filename = os.path.basename(path)
            if progress_callback:
                progress_callback(i, total, filename)

            if mode == "super_res":
                enhanced = self.enhance_super_res(path)
            else:
                enhanced = self.enhance_standard(path)

            enhanced_paths.append(enhanced)

        if progress_callback:
            progress_callback(total, total, "Done")

        logger.info(
            f"Enhanced {total} images (mode={mode}): "
            f"{sum(1 for p in enhanced_paths if '_enhanced' in p)} modified"
        )
        return enhanced_paths


# ── Internal Processing Functions ──────────────────────────

def _rgb_to_lab(arr: np.ndarray) -> np.ndarray:
    """Convert RGB (0-255 float) to LAB color space.

    Uses a simplified sRGB → XYZ → LAB conversion.
    L: 0-100 (lightness), a: ~-128 to 127, b: ~-128 to 127.
    """
    # Normalize to 0-1
    rgb = arr / 255.0

    # sRGB gamma → linear
    mask = rgb > 0.04045
    rgb_lin = np.where(mask, ((rgb + 0.055) / 1.055) ** 2.4, rgb / 12.92)

    # Linear RGB → XYZ (D65 illuminant)
    x = rgb_lin[:, :, 0] * 0.4124564 + rgb_lin[:, :, 1] * 0.3575761 + rgb_lin[:, :, 2] * 0.1804375
    y = rgb_lin[:, :, 0] * 0.2126729 + rgb_lin[:, :, 1] * 0.7151522 + rgb_lin[:, :, 2] * 0.0721750
    z = rgb_lin[:, :, 0] * 0.0193339 + rgb_lin[:, :, 1] * 0.1191920 + rgb_lin[:, :, 2] * 0.9503041

    # Normalize by D65 white point
    x /= 0.95047
    z /= 1.08883

    # XYZ → LAB
    epsilon = 0.008856
    kappa = 903.3

    def f(t):
        return np.where(t > epsilon, t ** (1.0 / 3.0), (kappa * t + 16.0) / 116.0)

    fx, fy, fz = f(x), f(y), f(z)

    L = 116.0 * fy - 16.0
    a = 500.0 * (fx - fy)
    b = 200.0 * (fy - fz)

    return np.stack([L, a, b], axis=2)


def _lab_to_rgb(lab: np.ndarray) -> np.ndarray:
    """Convert LAB color space back to RGB (0-255 float)."""
    L = lab[:, :, 0]
    a = lab[:, :, 1]
    b = lab[:, :, 2]

    # LAB → XYZ
    fy = (L + 16.0) / 116.0
    fx = a / 500.0 + fy
    fz = fy - b / 200.0

    epsilon = 0.008856
    kappa = 903.3

    x = np.where(fx ** 3 > epsilon, fx ** 3, (116.0 * fx - 16.0) / kappa)
    y = np.where(L > kappa * epsilon, ((L + 16.0) / 116.0) ** 3, L / kappa)
    z = np.where(fz ** 3 > epsilon, fz ** 3, (116.0 * fz - 16.0) / kappa)

    # Denormalize by D65 white point
    x *= 0.95047
    z *= 1.08883

    # XYZ → linear RGB
    r_lin = x * 3.2404542 - y * 1.5371385 - z * 0.4985314
    g_lin = -x * 0.9692660 + y * 1.8760108 + z * 0.0415560
    b_lin = x * 0.0556434 - y * 0.2040259 + z * 1.0572252

    # Clip negatives
    r_lin = np.clip(r_lin, 0, None)
    g_lin = np.clip(g_lin, 0, None)
    b_lin = np.clip(b_lin, 0, None)

    # Linear → sRGB gamma
    def gamma(c):
        return np.where(c > 0.0031308, 1.055 * (c ** (1.0 / 2.4)) - 0.055, 12.92 * c)

    rgb = np.stack([gamma(r_lin), gamma(g_lin), gamma(b_lin)], axis=2)
    return np.clip(rgb * 255.0, 0, 255)


def _apply_clahe_luminance(arr: np.ndarray) -> np.ndarray:
    """Apply CLAHE only to the luminance channel in LAB space.

    This enhances contrast without shifting colors, preventing
    the discoloration that occurs when CLAHE is applied per-RGB-channel.
    """
    h, w, c = arr.shape

    grid = CLAHE_GRID_SIZE
    tile_h = h // grid
    tile_w = w // grid

    if tile_h < 2 or tile_w < 2:
        return arr

    # Convert to LAB
    lab = _rgb_to_lab(arr)
    L = lab[:, :, 0]  # 0-100 range

    # Apply CLAHE to L channel only
    out_L = np.zeros_like(L)

    for row in range(grid):
        for col in range(grid):
            y1 = row * tile_h
            y2 = (row + 1) * tile_h if row < grid - 1 else h
            x1 = col * tile_w
            x2 = (col + 1) * tile_w if col < grid - 1 else w

            tile = L[y1:y2, x1:x2]

            # Quantize L to 0-255 for histogram
            tile_u8 = np.clip(tile * 2.55, 0, 255).astype(np.uint8)

            # Compute histogram
            hist, _ = np.histogram(tile_u8, bins=256, range=(0, 256))

            # Clip histogram
            clip = int(CLAHE_CLIP_LIMIT * tile_u8.size / 256)
            excess = np.sum(np.maximum(hist - clip, 0))
            hist = np.minimum(hist, clip)
            hist += excess // 256

            # Build CDF
            cdf = hist.cumsum()
            cdf_min = cdf[cdf > 0].min() if cdf.max() > 0 else 0
            denom = tile_u8.size - cdf_min
            if denom <= 0:
                out_L[y1:y2, x1:x2] = tile
                continue

            lut = ((cdf - cdf_min) / denom * 100.0).clip(0, 100)
            out_L[y1:y2, x1:x2] = lut[tile_u8]

    # Replace L channel, keep a and b untouched
    lab[:, :, 0] = out_L

    # Convert back to RGB
    return _lab_to_rgb(lab)


def _auto_white_balance(arr: np.ndarray, strength: float = 0.4) -> np.ndarray:
    """Gentle gray-world white balance correction.

    Blends the corrected result with the original to prevent
    drastic color shifts. A strength of 0 = no change, 1 = full correction.
    """
    means = arr.mean(axis=(0, 1))
    overall_mean = means.mean()

    if overall_mean < 1:
        return arr

    corrected = arr.copy()
    for ch in range(arr.shape[2]):
        if means[ch] > 1:
            corrected[:, :, ch] = arr[:, :, ch] * (overall_mean / means[ch])

    # Blend corrected with original
    return arr * (1.0 - strength) + corrected * strength


def _stretch_dynamic_range(arr: np.ndarray, strength: float = 0.6) -> np.ndarray:
    """Gently stretch pixel values toward the full 0-255 range.

    Uses wider percentile bounds (0.5th/99.5th) and blends the
    stretched result with the original to prevent harsh clipping.
    """
    stretched = arr.copy()

    for ch in range(arr.shape[2]):
        channel = arr[:, :, ch]
        p_low = np.percentile(channel, 0.5)   # wider than 1st percentile
        p_high = np.percentile(channel, 99.5)  # wider than 99th percentile

        if p_high - p_low < 10:
            continue  # Channel is nearly constant — skip

        stretched[:, :, ch] = np.clip(
            (channel - p_low) / (p_high - p_low) * 255.0,
            0, 255
        )

    # Blend stretched with original
    return arr * (1.0 - strength) + stretched * strength
