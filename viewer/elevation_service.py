"""
Elevation Service — GDAL-based raster sampling for DSM/DTM GeoTIFFs.

Provides point queries, profile interpolation, bounding-box statistics,
and raster metadata for the viewer elevation API.

GDAL is imported lazily so the module loads cleanly in environments
without GDAL installed (e.g. local dev without Docker).
"""

import logging
import math
from typing import Optional

logger = logging.getLogger("viewer")


def _open_raster(geotiff_path: str):
    """Open a GeoTIFF and return (dataset, band, geo_transform, projection)."""
    from osgeo import gdal

    ds = gdal.Open(geotiff_path)
    if not ds:
        raise FileNotFoundError(f"Cannot open GeoTIFF: {geotiff_path}")

    band = ds.GetRasterBand(1)
    gt = ds.GetGeoTransform()
    return ds, band, gt


def _geo_to_pixel(gt, lon: float, lat: float) -> tuple[int, int]:
    """Convert geographic (lon, lat) to pixel (col, row) using the GeoTransform."""
    col = int((lon - gt[0]) / gt[1])
    row = int((lat - gt[3]) / gt[5])
    return col, row


def _pixel_to_geo(gt, col: int, row: int) -> tuple[float, float]:
    """Convert pixel (col, row) to geographic (lon, lat) center of pixel."""
    lon = gt[0] + (col + 0.5) * gt[1]
    lat = gt[3] + (row + 0.5) * gt[5]
    return lon, lat


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine distance in meters between two WGS84 points."""
    R = 6_371_000  # Earth radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def sample_elevation(
    geotiff_path: str, lat: float, lon: float
) -> Optional[float]:
    """
    Sample a single elevation value from a DSM/DTM GeoTIFF.

    Args:
        geotiff_path: Absolute path to the GeoTIFF file.
        lat: Latitude (WGS84).
        lon: Longitude (WGS84).

    Returns:
        Elevation in meters, or None if the point is outside the raster
        or on a nodata pixel.
    """
    try:
        import numpy as np
        ds, band, gt = _open_raster(geotiff_path)

        col, row = _geo_to_pixel(gt, lon, lat)

        # Bounds check
        if col < 0 or col >= ds.RasterXSize or row < 0 or row >= ds.RasterYSize:
            return None

        value = band.ReadAsArray(col, row, 1, 1)
        if value is None:
            return None

        elev = float(value[0, 0])

        # Check nodata
        nodata = band.GetNoDataValue()
        if nodata is not None and (np.isnan(elev) or abs(elev - nodata) < 0.01):
            return None

        return round(elev, 2)

    except ImportError:
        logger.warning("GDAL not available — elevation query skipped")
        return None
    except FileNotFoundError:
        return None
    except Exception as e:
        logger.error(f"Elevation query failed: {e}")
        return None


def sample_profile(
    geotiff_path: str,
    points: list[tuple[float, float]],
    num_samples: int = 100,
) -> dict:
    """
    Sample elevation along a polyline path defined by (lat, lon) waypoints.

    Interpolates `num_samples` evenly-spaced points along the path and
    reads the elevation at each.

    Returns:
        {
            "profile": [{"distance_m": ..., "elevation_m": ..., "lat": ..., "lon": ...}, ...],
            "stats": {"min_m": ..., "max_m": ..., "range_m": ..., "avg_m": ..., "total_distance_m": ...}
        }
    """
    try:
        import numpy as np
        ds, band, gt = _open_raster(geotiff_path)
        nodata = band.GetNoDataValue()

        # Compute cumulative distance along waypoints
        seg_distances = [0.0]
        for i in range(1, len(points)):
            d = _haversine_m(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1])
            seg_distances.append(seg_distances[-1] + d)
        total_distance = seg_distances[-1]

        if total_distance < 0.01:
            return {"profile": [], "stats": {}}

        # Interpolate evenly spaced points along the polyline
        profile = []
        sample_distances = [total_distance * i / max(num_samples - 1, 1) for i in range(num_samples)]

        seg_idx = 0
        for sd in sample_distances:
            # Find which segment this distance falls on
            while seg_idx < len(seg_distances) - 2 and sd > seg_distances[seg_idx + 1]:
                seg_idx += 1

            # Interpolation fraction within segment
            seg_start = seg_distances[seg_idx]
            seg_end = seg_distances[min(seg_idx + 1, len(seg_distances) - 1)]
            seg_len = seg_end - seg_start
            t = (sd - seg_start) / seg_len if seg_len > 0 else 0.0
            t = max(0.0, min(1.0, t))

            p1 = points[seg_idx]
            p2 = points[min(seg_idx + 1, len(points) - 1)]
            lat = p1[0] + t * (p2[0] - p1[0])
            lon = p1[1] + t * (p2[1] - p1[1])

            # Sample elevation
            col, row = _geo_to_pixel(gt, lon, lat)
            elev = None
            if 0 <= col < ds.RasterXSize and 0 <= row < ds.RasterYSize:
                val = band.ReadAsArray(col, row, 1, 1)
                if val is not None:
                    e = float(val[0, 0])
                    if nodata is None or (not np.isnan(e) and abs(e - nodata) > 0.01):
                        elev = round(e, 2)

            profile.append({
                "distance_m": round(sd, 2),
                "elevation_m": elev,
                "lat": round(lat, 7),
                "lon": round(lon, 7),
            })

        # Compute stats from valid elevations
        valid_elevs = [p["elevation_m"] for p in profile if p["elevation_m"] is not None]
        stats = {}
        if valid_elevs:
            stats = {
                "min_m": round(min(valid_elevs), 2),
                "max_m": round(max(valid_elevs), 2),
                "range_m": round(max(valid_elevs) - min(valid_elevs), 2),
                "avg_m": round(sum(valid_elevs) / len(valid_elevs), 2),
                "total_distance_m": round(total_distance, 2),
            }

        return {"profile": profile, "stats": stats}

    except ImportError:
        logger.warning("GDAL not available — elevation profile skipped")
        return {"profile": [], "stats": {}}
    except FileNotFoundError:
        return {"profile": [], "stats": {}}
    except Exception as e:
        logger.error(f"Elevation profile failed: {e}")
        return {"profile": [], "stats": {}}


def compute_bbox_stats(
    geotiff_path: str,
    bbox: tuple[float, float, float, float],
) -> dict:
    """
    Compute elevation statistics over a bounding box region.

    Args:
        geotiff_path: Path to DSM/DTM GeoTIFF.
        bbox: (min_lat, min_lon, max_lat, max_lon)

    Returns:
        {"min_m": ..., "max_m": ..., "range_m": ..., "avg_m": ..., "pixel_count": ...}
    """
    try:
        import numpy as np
        ds, band, gt = _open_raster(geotiff_path)
        nodata = band.GetNoDataValue()

        min_lat, min_lon, max_lat, max_lon = bbox

        # Convert bbox corners to pixel coordinates
        col1, row1 = _geo_to_pixel(gt, min_lon, max_lat)  # top-left
        col2, row2 = _geo_to_pixel(gt, max_lon, min_lat)  # bottom-right

        # Clamp to raster bounds
        col1 = max(0, min(col1, ds.RasterXSize - 1))
        col2 = max(0, min(col2, ds.RasterXSize - 1))
        row1 = max(0, min(row1, ds.RasterYSize - 1))
        row2 = max(0, min(row2, ds.RasterYSize - 1))

        if col1 > col2:
            col1, col2 = col2, col1
        if row1 > row2:
            row1, row2 = row2, row1

        width = col2 - col1 + 1
        height = row2 - row1 + 1

        if width <= 0 or height <= 0:
            return {}

        data = band.ReadAsArray(col1, row1, width, height).astype(float)

        # Mask nodata
        if nodata is not None:
            data = np.where(np.isclose(data, nodata), np.nan, data)
        data = data[~np.isnan(data)]

        if data.size == 0:
            return {}

        return {
            "min_m": round(float(np.min(data)), 2),
            "max_m": round(float(np.max(data)), 2),
            "range_m": round(float(np.max(data) - np.min(data)), 2),
            "avg_m": round(float(np.mean(data)), 2),
            "pixel_count": int(data.size),
        }

    except ImportError:
        logger.warning("GDAL not available — bbox stats skipped")
        return {}
    except Exception as e:
        logger.error(f"Bbox elevation stats failed: {e}")
        return {}


def get_raster_bounds(geotiff_path: str) -> Optional[dict]:
    """
    Return the geographic bounding box of a GeoTIFF.

    Returns:
        {"min_lat": ..., "min_lon": ..., "max_lat": ..., "max_lon": ...}
    """
    try:
        ds, _, gt = _open_raster(geotiff_path)
        w = ds.RasterXSize
        h = ds.RasterYSize

        min_lon = gt[0]
        max_lon = gt[0] + w * gt[1]
        max_lat = gt[3]
        min_lat = gt[3] + h * gt[5]

        return {
            "min_lat": round(min(min_lat, max_lat), 7),
            "min_lon": round(min(min_lon, max_lon), 7),
            "max_lat": round(max(min_lat, max_lat), 7),
            "max_lon": round(max(min_lon, max_lon), 7),
        }
    except Exception:
        return None


def get_elevation_range(geotiff_path: str) -> Optional[tuple[float, float]]:
    """
    Return the global (min, max) elevation values in the raster.
    """
    try:
        _, band, _ = _open_raster(geotiff_path)
        stats = band.GetStatistics(True, True)  # approx=True, force=True
        return (round(stats[0], 2), round(stats[1], 2))
    except Exception:
        return None


def crop_orthophoto(
    geotiff_path: str,
    lat: float,
    lon: float,
    size_px: int = 512,
) -> Optional[bytes]:
    """Crop a square region from a GeoTIFF orthophoto centered on (lat, lon).

    Reads the raw raster pixel data at the geo-coordinate, extracts a
    square crop, and returns it as JPEG bytes. This provides the AI
    vision model with a high-resolution, correctly-oriented aerial image
    of the selected location.

    Args:
        geotiff_path: Absolute path to the orthophoto GeoTIFF.
        lat: Center latitude (WGS84 or projected CRS matching the raster).
        lon: Center longitude.
        size_px: Output image size in pixels (square).

    Returns:
        JPEG bytes, or None if the point is outside the raster extent.
    """
    try:
        from osgeo import gdal
        from PIL import Image
        import numpy as np
        import io

        ds = gdal.Open(geotiff_path)
        if not ds:
            return None

        gt = ds.GetGeoTransform()
        center_col, center_row = _geo_to_pixel(gt, lon, lat)

        # Check bounds
        if (center_col < 0 or center_col >= ds.RasterXSize or
                center_row < 0 or center_row >= ds.RasterYSize):
            return None

        # Determine crop window (in raster pixels)
        # Use a window large enough to capture the object's context
        half = size_px // 2
        x_off = max(0, center_col - half)
        y_off = max(0, center_row - half)
        x_end = min(ds.RasterXSize, center_col + half)
        y_end = min(ds.RasterYSize, center_row + half)

        win_w = x_end - x_off
        win_h = y_end - y_off

        if win_w < 10 or win_h < 10:
            return None

        # Read RGB bands (orthophotos are typically 3 or 4 bands)
        num_bands = min(ds.RasterCount, 3)  # Only need RGB
        bands = []
        for b in range(1, num_bands + 1):
            band_data = ds.GetRasterBand(b).ReadAsArray(
                x_off, y_off, win_w, win_h
            )
            if band_data is None:
                return None
            bands.append(band_data)

        if len(bands) < 3:
            # Grayscale — expand to RGB
            while len(bands) < 3:
                bands.append(bands[0])

        # Stack to (H, W, 3) RGB array
        rgb = np.dstack(bands)

        # Normalize if data is uint16 (common in orthophotos)
        if rgb.dtype == np.uint16:
            rgb = (rgb / 256).astype(np.uint8)
        elif rgb.dtype != np.uint8:
            # Float or other — normalize to 0-255
            vmin, vmax = np.nanmin(rgb), np.nanmax(rgb)
            if vmax > vmin:
                rgb = ((rgb - vmin) / (vmax - vmin) * 255).astype(np.uint8)
            else:
                rgb = np.zeros_like(rgb, dtype=np.uint8)

        # Create PIL image and resize to target size
        img = Image.fromarray(rgb)
        img = img.resize((size_px, size_px), Image.LANCZOS)

        # Encode as JPEG
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)
        buf.seek(0)

        logger.info(
            f"Orthophoto crop: {size_px}×{size_px} at ({lat:.5f}, {lon:.5f})"
        )
        return buf.read()

    except ImportError:
        logger.warning("GDAL/Pillow not available — orthophoto crop skipped")
        return None
    except Exception as e:
        logger.error(f"Orthophoto crop failed: {e}")
        return None
