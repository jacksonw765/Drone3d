"""
Orthophoto Tile Server for TAK/ATAK.

Serves orthophoto GeoTIFFs as slippy map tiles (TMS/WMTS)
compatible with ATAK's custom map source feature.

Uses GDAL to reproject and generate tile pyramids. Results
are cached to disk for fast subsequent requests.

NOTE: GDAL (osgeo) is imported lazily to allow the module to
load in environments without GDAL (e.g., local dev). GDAL is
available inside the Docker container.
"""

import logging
from pathlib import Path

logger = logging.getLogger("tak_integration")


class OrthophotoTileServer:
    """Generate and serve map tiles from GeoTIFF orthophotos."""

    def __init__(self, cache_dir: str = None):
        from django.conf import settings
        self.cache_dir = Path(cache_dir or str(settings.MEDIA_ROOT / "tile_cache"))
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def generate_tiles(
        self,
        geotiff_path: str,
        project_id: str,
        min_zoom: int = 10,
        max_zoom: int = 22,
    ) -> Path:
        """Pre-generate a tile pyramid from an orthophoto GeoTIFF."""
        output_dir = self.cache_dir / project_id
        output_dir.mkdir(parents=True, exist_ok=True)

        try:
            from osgeo_utils import gdal2tiles
            gdal2tiles.main([
                "",
                "-z", f"{min_zoom}-{max_zoom}",
                "-w", "none",
                "--tmscompatible",
                "--processes=4",
                str(geotiff_path),
                str(output_dir),
            ])
            logger.info(f"Generated tiles for project {project_id} at {output_dir}")
        except Exception as e:
            logger.error(f"Tile generation failed for {project_id}: {e}")
            raise

        return output_dir

    def get_tile(self, project_id: str, z: int, x: int, y: int) -> bytes | None:
        """Retrieve a single tile as PNG bytes. Returns None if not found."""
        tile_path = self.cache_dir / project_id / str(z) / str(x) / f"{y}.png"
        if tile_path.exists():
            return tile_path.read_bytes()
        return None

    def has_tiles(self, project_id: str) -> bool:
        """Check if tiles have been generated for a project."""
        project_dir = self.cache_dir / project_id
        return project_dir.exists() and any(project_dir.iterdir())

    def get_bounds(self, geotiff_path: str) -> dict | None:
        """Return geographic bounding box (WGS84) for ATAK layer config."""
        try:
            from osgeo import gdal, osr

            ds = gdal.Open(geotiff_path)
            if not ds:
                return None

            gt = ds.GetGeoTransform()
            width = ds.RasterXSize
            height = ds.RasterYSize

            min_x = gt[0]
            max_y = gt[3]
            max_x = gt[0] + width * gt[1]
            min_y = gt[3] + height * gt[5]

            src_srs = osr.SpatialReference(wkt=ds.GetProjection())
            dst_srs = osr.SpatialReference()
            dst_srs.ImportFromEPSG(4326)
            dst_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
            src_srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)

            transform = osr.CoordinateTransformation(src_srs, dst_srs)

            tl = transform.TransformPoint(min_x, max_y)
            br = transform.TransformPoint(max_x, min_y)

            return {
                "north": max(tl[1], br[1]),
                "south": min(tl[1], br[1]),
                "east": max(tl[0], br[0]),
                "west": min(tl[0], br[0]),
            }
        except Exception as e:
            logger.error(f"Failed to get bounds for {geotiff_path}: {e}")
            return None

    def generate_map_source_xml(
        self,
        project_id: str,
        project_name: str,
        host: str = "localhost:8000",
    ) -> str:
        """Generate ATAK custom map source XML for this project's tiles."""
        return f"""<?xml version="1.0" encoding="UTF-8"?>
<customMapSource>
    <name>Drone3D — {project_name}</name>
    <url>http://{host}/tak/tiles/{project_id}/{{z}}/{{x}}/{{y}}.png</url>
    <minZoom>10</minZoom>
    <maxZoom>22</maxZoom>
    <tileType>png</tileType>
</customMapSource>"""
