"""
Orthophoto Tile Analyzer.

Slices orthophoto GeoTIFFs into georeferenced tiles, runs each
through the Ollama vision model for tactical object detection,
deduplicates overlapping detections, and generates tactical
summary reports.
"""

import base64
import io
import json
import logging

import numpy as np
from math import radians, cos, sin, sqrt, atan2
from PIL import Image

logger = logging.getLogger("ai_analysis")


class TileAnalyzer:
    """Slices orthophotos and runs AI analysis on each tile."""

    ANALYSIS_PROMPT = """You are a tactical imagery analyst examining an
aerial orthophoto tile from a drone survey. Analyze this image and identify
all significant features.

For each feature found, provide:
- label: descriptive name (e.g., "Two-story residential building")
- category: one of [structure, vehicle, road, landing_zone, obstacle,
  vegetation, water, cleared_area, defensive_position, antenna_tower]
- relative_position: [x, y] as fraction of image (0.0-1.0 from top-left)
- confidence: 0.0-1.0
- description: brief tactical description
- size_estimate: approximate size in meters if determinable

Respond as a JSON array. If no significant features, return []."""

    def __init__(self, client):
        self.client = client

    def slice_orthophoto(
        self,
        geotiff_path: str,
        tile_size: int = 512,
        overlap: float = 0.15,
    ) -> list[dict]:
        """Slice a GeoTIFF into georeferenced tiles for analysis.

        Args:
            geotiff_path: Path to the orthophoto GeoTIFF
            tile_size: Size of each tile in pixels
            overlap: Overlap fraction between adjacent tiles

        Returns:
            List of tile dicts with image_b64, bounds, and pixel_offset
        """
        from osgeo import gdal, osr

        ds = gdal.Open(geotiff_path)
        if not ds:
            logger.error(f"Cannot open GeoTIFF: {geotiff_path}")
            return []

        width = ds.RasterXSize
        height = ds.RasterYSize
        gt = ds.GetGeoTransform()

        # Set up coordinate transformation to WGS84
        src_srs = osr.SpatialReference(wkt=ds.GetProjection())
        wgs84 = osr.SpatialReference()
        wgs84.ImportFromEPSG(4326)
        wgs84.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        src_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        transform = osr.CoordinateTransformation(src_srs, wgs84)

        step = int(tile_size * (1 - overlap))
        tiles = []

        for y in range(0, height - tile_size + 1, step):
            for x in range(0, width - tile_size + 1, step):
                data = ds.ReadAsArray(x, y, tile_size, tile_size)
                if data is None:
                    continue

                # Convert raster data to PIL Image
                if data.ndim == 3:
                    # Multi-band (e.g., RGB or RGBA)
                    if data.shape[0] >= 3:
                        rgb = np.transpose(data[:3], (1, 2, 0))
                    else:
                        rgb = np.transpose(data, (1, 2, 0))
                    img = Image.fromarray(rgb.astype(np.uint8))
                else:
                    img = Image.fromarray(data.astype(np.uint8))

                # Skip mostly empty / black tiles
                arr = np.array(img)
                if arr.mean() < 5:
                    continue

                # Compute tile bounds in WGS84
                tl_x = gt[0] + x * gt[1] + y * gt[2]
                tl_y = gt[3] + x * gt[4] + y * gt[5]
                br_x = gt[0] + (x + tile_size) * gt[1] + (y + tile_size) * gt[2]
                br_y = gt[3] + (x + tile_size) * gt[4] + (y + tile_size) * gt[5]

                tl_transformed = transform.TransformPoint(tl_x, tl_y)
                br_transformed = transform.TransformPoint(br_x, br_y)

                tl_lon, tl_lat = tl_transformed[0], tl_transformed[1]
                br_lon, br_lat = br_transformed[0], br_transformed[1]

                # Encode as PNG base64
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

                tiles.append({
                    "image_b64": b64,
                    "bounds": {
                        "north": max(tl_lat, br_lat),
                        "south": min(tl_lat, br_lat),
                        "east": max(tl_lon, br_lon),
                        "west": min(tl_lon, br_lon),
                    },
                    "pixel_offset": (x, y),
                })

        logger.info(
            f"Sliced {geotiff_path} into {len(tiles)} tiles "
            f"({tile_size}px, {overlap:.0%} overlap)"
        )
        return tiles

    def analyze_tile(self, tile: dict) -> list[dict]:
        """Run vision model on a single tile, return georeferenced detections.

        Args:
            tile: Tile dict from slice_orthophoto

        Returns:
            List of detection dicts with lat, lon, label, category, confidence
        """
        try:
            result = self.client.structured_output(
                prompt=self.ANALYSIS_PROMPT,
                schema_hint='[{"label":"...","category":"...","relative_position":[x,y],"confidence":0.0}]',
                images=[tile["image_b64"]],
            )
        except (json.JSONDecodeError, Exception) as e:
            logger.warning(f"Tile analysis failed: {e}")
            return []

        if not isinstance(result, list):
            return []

        detections = []
        bounds = tile["bounds"]

        for det in result:
            pos = det.get("relative_position", [0.5, 0.5])
            if not isinstance(pos, (list, tuple)) or len(pos) < 2:
                pos = [0.5, 0.5]

            rx, ry = float(pos[0]), float(pos[1])
            rx = max(0.0, min(1.0, rx))
            ry = max(0.0, min(1.0, ry))

            det_lat = bounds["north"] - ry * (bounds["north"] - bounds["south"])
            det_lon = bounds["west"] + rx * (bounds["east"] - bounds["west"])

            confidence = float(det.get("confidence", 0.5))
            if confidence < 0: confidence = 0
            if confidence > 1: confidence = 1

            detections.append({
                "label": str(det.get("label", "Unknown"))[:255],
                "category": self._normalize_category(
                    str(det.get("category", "poi"))
                ),
                "lat": det_lat,
                "lon": det_lon,
                "confidence": confidence,
                "metadata": {
                    "description": str(det.get("description", "")),
                    "size_estimate": str(det.get("size_estimate", "")),
                },
            })
        return detections

    def deduplicate_detections(
        self,
        detections: list[dict],
        distance_threshold_m: float = 5.0,
    ) -> list[dict]:
        """Merge detections within threshold distance, keeping highest confidence.

        Uses haversine distance to merge nearby detections of the same category.
        Cluster position is set to the mean of all detections in the cluster.
        """
        if not detections:
            return []

        merged = []
        used = set()
        sorted_dets = sorted(detections, key=lambda d: -d["confidence"])

        for i, det in enumerate(sorted_dets):
            if i in used:
                continue
            cluster = [det]
            for j in range(i + 1, len(sorted_dets)):
                if j in used:
                    continue
                other = sorted_dets[j]
                dist = self._haversine(
                    det["lat"], det["lon"],
                    other["lat"], other["lon"],
                )
                if dist <= distance_threshold_m and det["category"] == other["category"]:
                    cluster.append(other)
                    used.add(j)

            # Use highest-confidence detection as the base
            best = max(cluster, key=lambda d: d["confidence"])
            best["lat"] = float(np.mean([d["lat"] for d in cluster]))
            best["lon"] = float(np.mean([d["lon"] for d in cluster]))
            merged.append(best)

        logger.info(
            f"Deduplicated {len(detections)} detections "
            f"to {len(merged)} (threshold: {distance_threshold_m}m)"
        )
        return merged

    def enrich_with_elevation(
        self,
        detections: list[dict],
        dsm_path: str,
    ) -> list[dict]:
        """Add elevation data to detections from the DSM.

        Samples the DSM raster at each detection's lat/lon to get
        the surface elevation.
        """
        try:
            from osgeo import gdal, osr
        except ImportError:
            logger.warning("GDAL not available — elevation enrichment skipped")
            return detections

        ds = gdal.Open(dsm_path)
        if not ds:
            return detections

        gt = ds.GetGeoTransform()
        band = ds.GetRasterBand(1)
        nodata = band.GetNoDataValue()

        # Set up inverse transform (WGS84 -> raster CRS)
        src_srs = osr.SpatialReference(wkt=ds.GetProjection())
        wgs84 = osr.SpatialReference()
        wgs84.ImportFromEPSG(4326)
        wgs84.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        src_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        inv_transform = osr.CoordinateTransformation(wgs84, src_srs)

        for det in detections:
            try:
                # Transform detection coords to raster CRS
                x, y, _ = inv_transform.TransformPoint(det["lon"], det["lat"])
                # Convert to pixel coordinates
                px = int((x - gt[0]) / gt[1])
                py = int((y - gt[3]) / gt[5])

                if 0 <= px < ds.RasterXSize and 0 <= py < ds.RasterYSize:
                    val = band.ReadAsArray(px, py, 1, 1)
                    if val is not None:
                        elev = float(val[0][0])
                        if nodata is None or elev != nodata:
                            det["elevation"] = round(elev, 1)
            except Exception:
                continue

        return detections

    def generate_tactical_summary(self, project, annotations) -> str:
        """Generate a natural-language tactical summary of the analyzed scene.

        Args:
            project: DroneProject instance
            annotations: Queryset or list of GeoAnnotation instances

        Returns:
            Tactical assessment text
        """
        annotation_data = []
        for a in annotations:
            entry = {
                "label": a.label,
                "category": a.category,
                "lat": a.latitude,
                "lon": a.longitude,
                "confidence": a.confidence,
            }
            if hasattr(a, "metadata") and a.metadata:
                entry["description"] = a.metadata.get("description", "")
            annotation_data.append(entry)

        center_lat = project.approx_latitude or "unknown"
        center_lon = project.approx_longitude or "unknown"

        prompt = f"""You are a tactical intelligence analyst. Based on the
following AI-detected features from a drone survey of the area around
({center_lat}, {center_lon}), write a concise tactical assessment.

Detected features:
{json.dumps(annotation_data, indent=2)}

Include:
1. TERRAIN SUMMARY — overall area description
2. KEY FEATURES — notable structures, vehicles, obstacles
3. LANDING ZONES — identified or potential LZ suitability
4. ROUTES — suggested approach/egress based on terrain and obstacles
5. THREATS/CONCERNS — anything tactically significant
6. RECOMMENDATIONS — actionable intelligence for mission planning

Keep it concise, factual, and in standard military intelligence format."""

        return self.client.generate(prompt)

    @staticmethod
    def _normalize_category(raw: str) -> str:
        """Map AI-generated category strings to our canonical categories."""
        mapping = {
            "structure": "structure",
            "building": "structure",
            "house": "structure",
            "vehicle": "vehicle",
            "car": "vehicle",
            "truck": "vehicle",
            "road": "poi",
            "path": "poi",
            "landing_zone": "lz",
            "lz": "lz",
            "cleared_area": "lz",
            "obstacle": "obstacle",
            "tower": "obstacle",
            "antenna_tower": "obstacle",
            "threat": "threat",
            "defensive_position": "threat",
            "vegetation": "poi",
            "water": "poi",
        }
        return mapping.get(raw.lower().strip(), "poi")

    @staticmethod
    def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Calculate distance between two points in meters using haversine formula."""
        R = 6371000  # Earth radius in meters
        dlat = radians(lat2 - lat1)
        dlon = radians(lon2 - lon1)
        a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
        return R * 2 * atan2(sqrt(a), sqrt(1 - a))
