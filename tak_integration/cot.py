"""
Cursor-on-Target (CoT) XML message builder.

Builds CoT 2.0 XML events per MIL-STD-2525 / CoT schema.
Supports: point events, sensor points of interest,
route waypoints, and image overlays.
"""

import uuid
from datetime import datetime, timedelta
from lxml import etree


def build_cot_event(
    event_type: str,
    lat: float,
    lon: float,
    hae: float = 0.0,
    callsign: str = "",
    uid: str = None,
    stale_minutes: int = 10,
    details: dict = None,
    ce: float = 10.0,
    le: float = 10.0,
) -> str:
    """
    Build a CoT XML event string.

    Args:
        event_type: CoT type string (e.g., "a-f-G-U-C" for friendly ground unit)
        lat: Latitude in decimal degrees (WGS84)
        lon: Longitude in decimal degrees (WGS84)
        hae: Height above ellipsoid in meters
        callsign: Display name for the marker
        uid: Unique identifier (auto-generated if not provided)
        stale_minutes: Minutes before the event goes stale
        details: Dict of detail sub-elements, e.g. {"remarks": {"text": "..."}}
        ce: Circular error in meters
        le: Linear error in meters

    Returns:
        UTF-8 encoded CoT XML string
    """
    uid = uid or f"drone3d-{uuid.uuid4()}"
    now = datetime.utcnow()
    stale = now + timedelta(minutes=stale_minutes)

    time_fmt = "%Y-%m-%dT%H:%M:%SZ"

    event = etree.Element("event", {
        "version": "2.0",
        "uid": uid,
        "type": event_type,
        "time": now.strftime(time_fmt),
        "start": now.strftime(time_fmt),
        "stale": stale.strftime(time_fmt),
        "how": "m-g",  # machine-generated
    })

    etree.SubElement(event, "point", {
        "lat": str(lat),
        "lon": str(lon),
        "hae": str(hae),
        "ce": str(ce),
        "le": str(le),
    })

    detail = etree.SubElement(event, "detail")
    if callsign:
        etree.SubElement(detail, "contact", callsign=callsign)
    if details:
        for key, val in details.items():
            if isinstance(val, dict):
                etree.SubElement(detail, key, **{
                    k: str(v) for k, v in val.items()
                })
            else:
                elem = etree.SubElement(detail, key)
                elem.text = str(val)

    return etree.tostring(
        event, xml_declaration=True, encoding="UTF-8"
    ).decode("utf-8")


def build_cot_sa_event(
    lat: float,
    lon: float,
    callsign: str = "DRONE3D",
    uid: str = None,
    team: str = "Cyan",
    role: str = "HQ",
) -> str:
    """Build a situational awareness (SA) CoT event for Drone3D's own position."""
    uid = uid or f"drone3d-sa-{uuid.uuid4()}"
    details = {
        "__group": {"name": team, "role": role},
    }
    return build_cot_event(
        event_type="a-f-G-U-C",
        lat=lat,
        lon=lon,
        callsign=callsign,
        uid=uid,
        details=details,
    )


def parse_cot_event(xml_string: str) -> dict:
    """Parse a CoT XML event into a dict structure."""
    tree = etree.fromstring(xml_string.encode("utf-8") if isinstance(xml_string, str) else xml_string)

    result = {
        "uid": tree.get("uid", ""),
        "type": tree.get("type", ""),
        "time": tree.get("time", ""),
        "start": tree.get("start", ""),
        "stale": tree.get("stale", ""),
        "how": tree.get("how", ""),
    }

    point = tree.find("point")
    if point is not None:
        result["point"] = {
            "lat": float(point.get("lat", 0)),
            "lon": float(point.get("lon", 0)),
            "hae": float(point.get("hae", 0)),
            "ce": float(point.get("ce", 0)),
            "le": float(point.get("le", 0)),
        }

    detail = tree.find("detail")
    if detail is not None:
        contact = detail.find("contact")
        if contact is not None:
            result["callsign"] = contact.get("callsign", "")
        remarks = detail.find("remarks")
        if remarks is not None:
            result["remarks"] = remarks.get("text", remarks.text or "")

    return result
