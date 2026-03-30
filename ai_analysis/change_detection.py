"""
Temporal Change Detection.

Compares two orthophotos of the same area across time, computes
difference heatmaps, extracts change regions, and uses the vision
model to classify what changed.
"""

import base64
import io
import json
import logging

import numpy as np
from PIL import Image
from scipy import ndimage

logger = logging.getLogger("ai_analysis")


class ChangeDetector:
    """Detects and classifies changes between two orthophotos of the same area."""

    def __init__(self, client):
        self.client = client

    def compute_difference_map(
        self,
        ortho_before: str,
        ortho_after: str,
    ) -> tuple[np.ndarray, dict]:
        """Compute pixel-level normalized difference heatmap.

        Args:
            ortho_before: Path to the earlier orthophoto GeoTIFF
            ortho_after: Path to the later orthophoto GeoTIFF

        Returns:
            Tuple of (difference heatmap as 2D array [0-1], metadata dict)
        """
        from osgeo import gdal

        ds1 = gdal.Open(ortho_before)
        ds2 = gdal.Open(ortho_after)

        if not ds1 or not ds2:
            raise ValueError("Cannot open one or both GeoTIFFs")

        # Align ds2 to ds1's grid
        bounds = self._get_bounds(ds1)
        ds2_aligned = gdal.Warp(
            "",
            ds2,
            format="MEM",
            xRes=ds1.GetGeoTransform()[1],
            yRes=abs(ds1.GetGeoTransform()[5]),
            outputBounds=bounds,
            resampleAlg=gdal.GRA_Bilinear,
        )

        arr1 = ds1.ReadAsArray().astype(np.float32)
        arr2 = ds2_aligned.ReadAsArray().astype(np.float32)

        # Handle dimension mismatch
        if arr1.shape != arr2.shape:
            min_h = min(arr1.shape[-2], arr2.shape[-2])
            min_w = min(arr1.shape[-1], arr2.shape[-1])
            if arr1.ndim == 3:
                arr1 = arr1[:, :min_h, :min_w]
                arr2 = arr2[:, :min_h, :min_w]
            else:
                arr1 = arr1[:min_h, :min_w]
                arr2 = arr2[:min_h, :min_w]

        # Compute difference
        if arr1.ndim == 3:
            diff = np.mean(np.abs(arr1 - arr2), axis=0)
        else:
            diff = np.abs(arr1 - arr2)

        # Normalize to 0-1
        diff_range = diff.max() - diff.min()
        if diff_range > 0:
            diff_norm = (diff - diff.min()) / diff_range
        else:
            diff_norm = np.zeros_like(diff)

        metadata = {
            "width": diff_norm.shape[1],
            "height": diff_norm.shape[0],
            "mean_change": float(diff_norm.mean()),
            "max_change": float(diff_norm.max()),
            "geotransform": list(ds1.GetGeoTransform()),
            "projection": ds1.GetProjection(),
        }

        return diff_norm, metadata

    def identify_change_regions(
        self,
        diff_map: np.ndarray,
        threshold: float = 0.3,
        min_area_px: int = 100,
    ) -> list[dict]:
        """Extract contiguous change regions above threshold.

        Args:
            diff_map: Normalized difference heatmap [0-1]
            threshold: Minimum change intensity to include
            min_area_px: Minimum region area in pixels

        Returns:
            List of region dicts with bbox, area, and intensity info
        """
        binary = (diff_map > threshold).astype(np.uint8)
        labeled, num_features = ndimage.label(binary)

        regions = []
        for i in range(1, num_features + 1):
            mask = labeled == i
            area = int(mask.sum())
            if area < min_area_px:
                continue

            ys, xs = np.where(mask)
            regions.append({
                "id": i,
                "bbox": (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())),
                "area_px": area,
                "center_px": (int(xs.mean()), int(ys.mean())),
                "max_intensity": float(diff_map[mask].max()),
                "mean_intensity": float(diff_map[mask].mean()),
            })

        logger.info(
            f"Found {len(regions)} change regions "
            f"(threshold={threshold}, min_area={min_area_px}px)"
        )
        return sorted(regions, key=lambda r: -r["area_px"])

    def ai_classify_changes(
        self,
        ortho_before: str,
        ortho_after: str,
        regions: list[dict],
        max_regions: int = 20,
    ) -> list[dict]:
        """Use vision model to classify what changed in each region.

        Creates side-by-side before/after crops for each region and
        asks the vision model to describe the change.
        """
        classified = []
        regions_to_process = regions[:max_regions]

        for region in regions_to_process:
            bbox = region["bbox"]

            before_crop = self._extract_crop(ortho_before, bbox)
            after_crop = self._extract_crop(ortho_after, bbox)

            if before_crop is None or after_crop is None:
                continue

            # Create side-by-side comparison image
            gap = 10
            combined = Image.new(
                "RGB",
                (before_crop.width * 2 + gap, before_crop.height),
                (40, 40, 40),
            )
            combined.paste(before_crop, (0, 0))
            combined.paste(after_crop, (before_crop.width + gap, 0))

            buf = io.BytesIO()
            combined.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

            prompt = """Analyze these two aerial images (LEFT=before, RIGHT=after).
Describe what changed between them. Classify the change as one of:
construction, demolition, vehicle_movement, vegetation_change,
earthwork, infrastructure, or unknown.

Respond as JSON:
{"change_type": "...", "description": "...", "tactical_significance": "low/medium/high"}"""

            try:
                result = self.client.structured_output(
                    prompt=prompt,
                    schema_hint='{"change_type":"...","description":"...","tactical_significance":"..."}',
                    images=[b64],
                )
                result.update({
                    "region_id": region["id"],
                    "bbox": region["bbox"],
                    "area_px": region["area_px"],
                    "center_px": region["center_px"],
                })
                classified.append(result)
            except Exception as e:
                logger.warning(f"Change classification failed for region {region['id']}: {e}")
                classified.append({
                    "region_id": region["id"],
                    "change_type": "unknown",
                    "description": "Classification failed",
                    "tactical_significance": "unknown",
                    "bbox": region["bbox"],
                    "area_px": region["area_px"],
                })

        return classified

    def generate_heatmap_image(self, diff_map: np.ndarray) -> bytes:
        """Convert a difference map to a colored heatmap PNG.

        Returns PNG image bytes for overlay rendering.
        """
        # Apply colormap: blue (no change) -> yellow -> red (high change)
        h, w = diff_map.shape
        heatmap = np.zeros((h, w, 4), dtype=np.uint8)

        # Red channel increases with change
        heatmap[:, :, 0] = (diff_map * 255).astype(np.uint8)
        # Green channel peaks in the middle
        heatmap[:, :, 1] = ((1 - np.abs(diff_map - 0.5) * 2) * 180).astype(np.uint8)
        # Blue channel decreases with change
        heatmap[:, :, 2] = ((1 - diff_map) * 100).astype(np.uint8)
        # Alpha based on change intensity (transparent where no change)
        heatmap[:, :, 3] = (diff_map * 200).astype(np.uint8)

        img = Image.fromarray(heatmap, "RGBA")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    def _extract_crop(self, geotiff_path: str, bbox: tuple) -> Image.Image | None:
        """Extract a crop from a GeoTIFF given pixel bounding box."""
        try:
            from osgeo import gdal

            ds = gdal.Open(geotiff_path)
            if not ds:
                return None

            x_min, y_min, x_max, y_max = bbox
            w = x_max - x_min
            h = y_max - y_min

            if w <= 0 or h <= 0:
                return None

            data = ds.ReadAsArray(x_min, y_min, w, h)
            if data is None:
                return None

            if data.ndim == 3:
                rgb = np.transpose(data[:3], (1, 2, 0))
            else:
                rgb = np.stack([data, data, data], axis=-1)

            return Image.fromarray(rgb.astype(np.uint8))
        except Exception as e:
            logger.warning(f"Crop extraction failed: {e}")
            return None

    @staticmethod
    def _get_bounds(ds) -> tuple:
        """Get the geographic bounds of a GDAL dataset."""
        gt = ds.GetGeoTransform()
        w = ds.RasterXSize
        h = ds.RasterYSize
        min_x = gt[0]
        max_x = gt[0] + w * gt[1]
        min_y = gt[3] + h * gt[5]
        max_y = gt[3]
        return (min_x, min_y, max_x, max_y)
