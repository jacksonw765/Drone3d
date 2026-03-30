"""
Elevation data export for TAK/ATAK.

Converts DSM/DTM GeoTIFF outputs to DTED format for ATAK import,
and generates contour line vectors as GeoJSON.

NOTE: GDAL (osgeo) is imported lazily to allow the module to load
in environments without GDAL installed.
"""

import logging
from pathlib import Path

logger = logging.getLogger("tak_integration")


def geotiff_to_dted(input_path: str, output_dir: str) -> str | None:
    """Convert a DSM/DTM GeoTIFF to DTED Level 2 format for ATAK import."""
    try:
        from osgeo import gdal

        ds = gdal.Open(input_path)
        if not ds:
            logger.error(f"Cannot open GeoTIFF: {input_path}")
            return None

        output_path = str(Path(output_dir) / "elevation.dt2")
        Path(output_dir).mkdir(parents=True, exist_ok=True)

        gdal.Translate(
            output_path,
            ds,
            format="DTED",
            outputSRS="EPSG:4326",
        )

        logger.info(f"Converted {input_path} to DTED: {output_path}")
        return output_path
    except ImportError:
        logger.warning("GDAL not available — DTED conversion skipped")
        return None
    except Exception as e:
        logger.error(f"DTED conversion failed: {e}")
        return None


def generate_contour_geojson(
    dsm_path: str,
    output_path: str,
    interval: float = 5.0,
) -> str | None:
    """Generate contour lines from a DSM and export as GeoJSON."""
    try:
        from osgeo import gdal, ogr

        ds = gdal.Open(dsm_path)
        if not ds:
            return None

        band = ds.GetRasterBand(1)

        drv = ogr.GetDriverByName("GeoJSON")
        out_ds = drv.CreateDataSource(output_path)
        srs = ds.GetSpatialRef()
        layer = out_ds.CreateLayer("contours", srs, ogr.wkbLineString)

        field_defn = ogr.FieldDefn("elevation", ogr.OFTReal)
        layer.CreateField(field_defn)

        gdal.ContourGenerate(
            band, interval, 0, [], 0, 0, layer, 0, 1,
        )

        out_ds = None  # flush
        logger.info(f"Generated contours at {interval}m interval: {output_path}")
        return output_path
    except ImportError:
        logger.warning("GDAL not available — contour generation skipped")
        return None
    except Exception as e:
        logger.error(f"Contour generation failed: {e}")
        return None
