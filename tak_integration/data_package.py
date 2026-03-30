"""
ATAK Data Package Builder.

One-click export of a complete ATAK-importable data package (.zip)
containing map tiles, elevation data, CoT markers, map source
configuration, and AI analysis reports.
"""

import logging
import zipfile
from pathlib import Path

from .tile_server import OrthophotoTileServer

logger = logging.getLogger("tak_integration")


def build_data_package(project, output_path: str) -> str:
    """
    Build an ATAK-importable data package for a Drone3D project.

    Contents:
      - Orthophoto tile cache (slippy map tiles)
      - Elevation data (DTED)
      - POI markers (CoT XML)
      - Map source config XML
      - AI analysis report (as CoT remarks)

    Args:
        project: DroneProject instance with completed reconstruction
        output_path: Full path for the output .zip file

    Returns:
        Path to the created zip file
    """
    from django.conf import settings

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
        pkg_name = f"Drone3D-{project.name}"
        pkg_uid = str(project.id)

        # 1. Map source config
        tile_server = OrthophotoTileServer()
        map_source_xml = tile_server.generate_map_source_xml(
            project_id=str(project.id),
            project_name=project.name,
        )
        zf.writestr(f"{pkg_uid}/maps/orthophoto.xml", map_source_xml)

        # 2. Pre-rendered tiles (if available)
        tile_dir = Path(str(settings.MEDIA_ROOT)) / "tile_cache" / str(project.id)
        if tile_dir.exists():
            tile_count = 0
            for tile_file in tile_dir.rglob("*.png"):
                arcname = f"{pkg_uid}/tiles/{tile_file.relative_to(tile_dir)}"
                zf.write(tile_file, arcname)
                tile_count += 1
            logger.info(f"Added {tile_count} tiles to data package")

        # 3. Elevation DTED (if available)
        dsm_path = project.get_output_path("dsm")
        if dsm_path:
            from .elevation import geotiff_to_dted
            import tempfile
            import os

            with tempfile.TemporaryDirectory() as tmpdir:
                dted_path = geotiff_to_dted(dsm_path, tmpdir)
                if dted_path and os.path.exists(dted_path):
                    zf.write(dted_path, f"{pkg_uid}/elevation/terrain.dt2")
                    logger.info("Added DTED elevation to data package")

        # 4. Annotations as CoT events
        annotations = project.annotations.all()
        cot_count = 0
        for annotation in annotations:
            try:
                cot_xml = annotation.to_cot()
                zf.writestr(
                    f"{pkg_uid}/cot/{annotation.id}.cot",
                    cot_xml,
                )
                cot_count += 1
            except Exception as e:
                logger.warning(f"Failed to export annotation {annotation.id}: {e}")
        logger.info(f"Added {cot_count} CoT events to data package")

        # 5. AI report (if available)
        if project.ai_report:
            zf.writestr(
                f"{pkg_uid}/reports/ai_analysis.txt",
                project.ai_report,
            )

        # 6. Manifest
        manifest_xml = _build_manifest_xml(
            uid=pkg_uid,
            name=pkg_name,
            tile_count=tile_count if tile_dir.exists() else 0,
            cot_count=cot_count,
        )
        zf.writestr("manifest.xml", manifest_xml)

    logger.info(f"Data package created: {output_path}")
    return output_path


def _build_manifest_xml(
    uid: str,
    name: str,
    tile_count: int = 0,
    cot_count: int = 0,
) -> str:
    """Build an ATAK data package manifest XML."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<MissionPackageManifest version="2">
    <Configuration>
        <Parameter name="uid" value="{uid}"/>
        <Parameter name="name" value="{name}"/>
        <Parameter name="onReceiveDelete" value="false"/>
    </Configuration>
    <Contents>
        <Content ignore="false" zipEntry="{uid}/maps/orthophoto.xml">
            <Parameter name="contentType" value="Map Source"/>
        </Content>
    </Contents>
    <!-- Stats: {tile_count} tiles, {cot_count} CoT events -->
</MissionPackageManifest>"""
