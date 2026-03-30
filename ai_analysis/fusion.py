"""
Multi-Source Data Fusion Engine.

Import, correlate, and fuse external data with Drone3D annotations.
Supports GeoJSON, KML, KMZ, GPX, and SHP vector formats plus
CoT XML events.
"""

import json
import logging
from math import atan2, cos, radians, sin, sqrt
from pathlib import Path

logger = logging.getLogger("ai_analysis")


class DataFusionEngine:
    """Import, correlate, and fuse external data with Drone3D annotations."""

    SUPPORTED_FORMATS = {
        ".geojson": "GeoJSON",
        ".kml": "KML",
        ".kmz": "LIBKML",
        ".gpx": "GPX",
        ".shp": "ESRI Shapefile",
    }

    def import_vector_layer(
        self,
        project,
        file_path: str,
        source_label: str = "external",
    ) -> int:
        """Import features from a vector file as GeoAnnotations.

        Supports GeoJSON, KML, KMZ, GPX, and Shapefile formats.

        Args:
            project: DroneProject instance
            file_path: Path to the vector file
            source_label: Label for the import source

        Returns:
            Number of features imported
        """
        from osgeo import ogr
        from processing.models import GeoAnnotation

        ext = Path(file_path).suffix.lower()
        driver_name = self.SUPPORTED_FORMATS.get(ext)
        if not driver_name:
            raise ValueError(
                f"Unsupported format: {ext}. "
                f"Supported: {', '.join(self.SUPPORTED_FORMATS.keys())}"
            )

        ds = ogr.Open(file_path)
        if not ds:
            raise ValueError(f"Cannot open file: {file_path}")

        layer = ds.GetLayer()
        count = 0

        for feature in layer:
            geom = feature.GetGeometryRef()
            if not geom:
                continue

            centroid = geom.Centroid()
            lon, lat = centroid.GetX(), centroid.GetY()

            # Extract attributes
            attrs = {}
            for i in range(feature.GetFieldCount()):
                name = feature.GetFieldDefnRef(i).GetName()
                value = feature.GetField(i)
                if value is not None:
                    attrs[name] = value

            label = (
                attrs.get("name")
                or attrs.get("Name")
                or attrs.get("title")
                or attrs.get("description")
                or f"{source_label}_{count}"
            )

            GeoAnnotation.objects.create(
                project=project,
                label=str(label)[:255],
                category="poi",
                latitude=lat,
                longitude=lon,
                source="external",
                metadata={
                    "import_source": source_label,
                    "original_attributes": attrs,
                    "geometry_type": geom.GetGeometryName(),
                },
            )
            count += 1

        logger.info(f"Imported {count} features from {file_path} ({source_label})")
        return count

    def import_cot_events(self, project, cot_xml_dir: str) -> int:
        """Import CoT XML events as GeoAnnotations.

        Args:
            project: DroneProject instance
            cot_xml_dir: Directory containing .cot XML files

        Returns:
            Number of events imported
        """
        from lxml import etree
        from processing.models import GeoAnnotation

        count = 0
        cot_dir = Path(cot_xml_dir)

        for cot_file in cot_dir.glob("*.cot"):
            try:
                tree = etree.parse(str(cot_file))
                event = tree.getroot()
                point = event.find("point")
                if point is None:
                    continue

                detail = event.find("detail")
                contact = detail.find("contact") if detail is not None else None
                callsign = contact.get("callsign", "") if contact is not None else ""

                GeoAnnotation.objects.create(
                    project=project,
                    label=callsign or event.get("uid", "Unknown"),
                    category=self._cot_type_to_category(event.get("type", "")),
                    latitude=float(point.get("lat")),
                    longitude=float(point.get("lon")),
                    altitude=float(point.get("hae", 0)),
                    source="tak",
                    cot_uid=event.get("uid", ""),
                    metadata={
                        "cot_type": event.get("type"),
                        "how": event.get("how"),
                    },
                )
                count += 1
            except Exception as e:
                logger.warning(f"Failed to import CoT file {cot_file}: {e}")
                continue

        logger.info(f"Imported {count} CoT events from {cot_xml_dir}")
        return count

    def correlate_sources(
        self,
        project,
        radius_m: float = 50.0,
        client=None,
    ) -> list[dict]:
        """Find and assess correlations between annotations from different sources.

        Identifies annotations from different sources that are within
        `radius_m` meters of each other, optionally using AI to assess
        whether they represent the same real-world feature.

        Args:
            project: DroneProject instance
            radius_m: Correlation radius in meters
            client: Optional OllamaClient for AI-assisted assessment

        Returns:
            List of correlation dicts
        """
        annotations = list(project.annotations.all())
        correlations = []

        for i, a in enumerate(annotations):
            for b in annotations[i + 1:]:
                if a.source == b.source:
                    continue

                dist = self._haversine(
                    a.latitude, a.longitude,
                    b.latitude, b.longitude,
                )

                if dist <= radius_m:
                    correlations.append({
                        "annotation_a": {
                            "id": str(a.id),
                            "label": a.label,
                            "source": a.source,
                            "category": a.category,
                        },
                        "annotation_b": {
                            "id": str(b.id),
                            "label": b.label,
                            "source": b.source,
                            "category": b.category,
                        },
                        "distance_m": round(dist, 1),
                    })

        if client and correlations:
            prompt = f"""Analyze these spatial correlations between different
intelligence sources. For each pair, assess whether they likely
represent the "same_feature", are "related", or are "coincidental".
Provide a brief rationale for each.

{json.dumps(correlations[:20], indent=2)}"""

            try:
                result = client.structured_output(
                    prompt=prompt,
                    schema_hint='[{"annotation_a":...,"annotation_b":...,"assessment":"...","rationale":"..."}]',
                )
                if isinstance(result, list):
                    return result
            except Exception as e:
                logger.warning(f"AI correlation assessment failed: {e}")

        return correlations

    @staticmethod
    def _cot_type_to_category(cot_type: str) -> str:
        """Map CoT type strings to Drone3D annotation categories."""
        if cot_type.startswith("a-h"):
            return "threat"
        elif cot_type.startswith("a-f"):
            return "poi"
        elif cot_type.startswith("b-r"):
            return "lz"
        elif cot_type.startswith("a-n-G-E-V"):
            return "vehicle"
        elif cot_type.startswith("a-n-G"):
            return "structure"
        return "poi"

    @staticmethod
    def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Calculate distance between two points in meters."""
        R = 6371000
        dlat = radians(lat2 - lat1)
        dlon = radians(lon2 - lon1)
        a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
        return R * 2 * atan2(sqrt(a), sqrt(1 - a))
