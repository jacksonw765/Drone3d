"""
Drone3D Preprocessing Layer.

Handles smart input detection, SRT parsing, and video frame extraction
with ffmpeg fallback when NodeODM cannot accept video files directly.

Includes intelligent frame selection: scene-change detection, sharpness
filtering, and adaptive FPS calculation to maximize reconstruction quality.
"""

import json
import logging
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path

import numpy as np
import piexif
from PIL import Image, ImageFilter

logger = logging.getLogger("processing")

# ── File type classification ────────────────────────────────

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".tif", ".tiff", ".png", ".dng"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".lrv", ".ts"}
SRT_EXTENSIONS = {".srt"}

# ── Target frame counts by quality preset ───────────────────
# These are the ideal number of frames for a video reconstruction.
# A 5-second 4K timelapse needs far more than 5 frames.
VIDEO_TARGET_FRAMES = {
    "low": 30,
    "medium": 60,
    "high": 90,
    "ultra": 120,
}

# Minimum FPS to extract — ensures we don't under-sample even for long videos
MIN_EXTRACT_FPS = 2.0
# Maximum FPS to extract — avoids near-duplicate frames from high-FPS sources
MAX_EXTRACT_FPS = 10.0
# Fraction of blurriest frames to discard
BLUR_DISCARD_RATIO = 0.20


class InputDetector:
    """Classify files by extension and determine overall input type."""

    @staticmethod
    def classify_file(filename: str) -> str:
        """Return 'image', 'video', 'srt', or 'unknown' based on extension."""
        ext = Path(filename).suffix.lower()
        if ext in IMAGE_EXTENSIONS:
            return "image"
        elif ext in VIDEO_EXTENSIONS:
            return "video"
        elif ext in SRT_EXTENSIONS:
            return "srt"
        return "unknown"

    @staticmethod
    def detect_input_type(file_list: list[str]) -> str:
        """
        Determine overall input type from a list of filenames.
        Returns 'images', 'video', 'mixed', or 'unknown'.
        """
        has_images = False
        has_video = False

        for filename in file_list:
            ftype = InputDetector.classify_file(filename)
            if ftype == "image":
                has_images = True
            elif ftype == "video":
                has_video = True

        if has_images and has_video:
            return "mixed"
        elif has_images:
            return "images"
        elif has_video:
            return "video"
        return "unknown"


# ── Video Probing ───────────────────────────────────────────

class VideoProbe:
    """Use ffprobe to extract video metadata (duration, FPS, resolution)."""

    @staticmethod
    def probe(video_path: str) -> dict:
        """
        Probe a video file and return metadata.

        Returns:
            dict with keys: duration, fps, width, height, codec, bitrate
        """
        cmd = [
            "ffprobe",
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            video_path,
        ]

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=30
            )
            if result.returncode != 0:
                logger.warning(f"ffprobe failed: {result.stderr[:300]}")
                return {}

            data = json.loads(result.stdout)
        except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError) as e:
            logger.warning(f"ffprobe error: {e}")
            return {}

        # Find the video stream
        video_stream = None
        for stream in data.get("streams", []):
            if stream.get("codec_type") == "video":
                video_stream = stream
                break

        if not video_stream:
            return {}

        # Parse FPS from r_frame_rate (e.g. "30000/1001" or "30/1")
        fps = 30.0
        r_frame_rate = video_stream.get("r_frame_rate", "30/1")
        try:
            num, den = r_frame_rate.split("/")
            fps = float(num) / float(den)
        except (ValueError, ZeroDivisionError):
            pass

        # Duration — prefer stream duration, fall back to format duration
        duration = 0.0
        for dur_key in ["duration"]:
            dur_str = video_stream.get(dur_key) or data.get("format", {}).get(dur_key)
            if dur_str:
                try:
                    duration = float(dur_str)
                    break
                except ValueError:
                    pass

        info = {
            "duration": duration,
            "fps": fps,
            "width": int(video_stream.get("width", 0)),
            "height": int(video_stream.get("height", 0)),
            "codec": video_stream.get("codec_name", "unknown"),
            "total_frames": int(duration * fps) if duration and fps else 0,
            "bitrate": int(data.get("format", {}).get("bit_rate", 0)),
        }

        logger.info(
            f"Video probe: {info['width']}x{info['height']} @ {info['fps']:.1f}fps, "
            f"{info['duration']:.1f}s, ~{info['total_frames']} frames, "
            f"codec={info['codec']}"
        )
        return info


# ── Sharpness Scoring ───────────────────────────────────────

def _score_sharpness(image_path: str) -> float:
    """
    Score an image's sharpness using Laplacian variance.
    Higher values = sharper image. Motion-blurred frames score low.
    """
    try:
        img = Image.open(image_path).convert("L")
        # Resize to a standard size for consistent scoring
        img = img.resize((640, 480), Image.LANCZOS)
        # Apply Laplacian kernel (edge-detection)
        laplacian = img.filter(ImageFilter.Kernel(
            size=(3, 3),
            kernel=[-1, -1, -1, -1, 8, -1, -1, -1, -1],
            scale=1,
            offset=128,
        ))
        # Convert to numpy for variance calculation
        arr = np.array(laplacian, dtype=np.float64)
        variance = arr.var()
        return variance
    except Exception as e:
        logger.warning(f"Sharpness scoring failed for {image_path}: {e}")
        return 0.0


def filter_blurry_frames(
    frame_paths: list[str],
    discard_ratio: float = BLUR_DISCARD_RATIO,
    min_keep: int = 10,
) -> list[str]:
    """
    Score all frames by sharpness and discard the blurriest ones.

    Args:
        frame_paths: List of frame image paths.
        discard_ratio: Fraction of frames to discard (0.0 – 1.0).
        min_keep: Minimum number of frames to keep even if all are blurry.

    Returns:
        Filtered list of frame paths, sorted by original order.
    """
    if len(frame_paths) <= min_keep:
        logger.info(f"Too few frames ({len(frame_paths)}) to filter, keeping all")
        return frame_paths

    # Score each frame
    scores = []
    for path in frame_paths:
        score = _score_sharpness(path)
        scores.append((path, score))

    # Sort by score ascending (blurriest first)
    scores.sort(key=lambda x: x[1])

    # Calculate how many to discard
    n_discard = int(len(scores) * discard_ratio)
    n_keep = max(len(scores) - n_discard, min_keep)

    # Take the sharpest frames
    kept = scores[len(scores) - n_keep:]

    # Log statistics
    all_scores = [s for _, s in scores]
    kept_scores = [s for _, s in kept]
    logger.info(
        f"Sharpness filtering: {len(frame_paths)} → {len(kept)} frames "
        f"(discarded {len(frame_paths) - len(kept)} blurry). "
        f"Score range: {min(all_scores):.1f}–{max(all_scores):.1f}, "
        f"kept min: {min(kept_scores):.1f}"
    )

    # Return in original order (by filename)
    kept_set = {path for path, _ in kept}
    return [p for p in frame_paths if p in kept_set]


# ── SRT Parsing ─────────────────────────────────────────────

class SRTParser:
    """
    Parse drone subtitle (.srt) files containing GPS telemetry.
    Supports DJI, Skydio, Autel, and Parrot format variants.
    """

    # DJI format: [latitude: 35.1234] [longitude: -106.5678] [altitude: 100.5]
    DJI_PATTERN = re.compile(
        r"\[latitude:\s*([+-]?\d+\.?\d*)\]\s*"
        r"\[longitude:\s*([+-]?\d+\.?\d*)\]\s*"
        r"\[altitude:\s*([+-]?\d+\.?\d*)\]",
        re.IGNORECASE,
    )

    # DJI alternate: GPS(35.1234, -106.5678, 100.5)
    DJI_ALT_PATTERN = re.compile(
        r"GPS\(\s*([+-]?\d+\.?\d*),\s*([+-]?\d+\.?\d*),\s*([+-]?\d+\.?\d*)\s*\)",
        re.IGNORECASE,
    )

    # Generic CSV-style: lat,lon,alt or similar
    GENERIC_PATTERN = re.compile(
        r"([+-]?\d{1,3}\.\d{4,})[,\s]+([+-]?\d{1,3}\.\d{4,})[,\s]+([+-]?\d+\.?\d*)"
    )

    # Timestamp pattern: HH:MM:SS,mmm --> HH:MM:SS,mmm
    TIMESTAMP_PATTERN = re.compile(
        r"(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})"
    )

    @classmethod
    def parse(cls, srt_path: str) -> list[dict]:
        """
        Parse an SRT file and return a list of entries with GPS data.
        Each entry: {index, start_time, end_time, lat, lon, alt}
        """
        entries = []
        try:
            with open(srt_path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
        except FileNotFoundError:
            logger.warning(f"SRT file not found: {srt_path}")
            return entries

        # Split into subtitle blocks (separated by blank lines)
        blocks = re.split(r"\n\s*\n", content.strip())

        for block in blocks:
            lines = block.strip().split("\n")
            if len(lines) < 2:
                continue

            entry = {"index": None, "start_time": 0.0, "lat": None, "lon": None, "alt": None}

            # Try to parse index (first line)
            try:
                entry["index"] = int(lines[0].strip())
            except (ValueError, IndexError):
                pass

            # Parse timestamp
            block_text = "\n".join(lines)
            ts_match = cls.TIMESTAMP_PATTERN.search(block_text)
            if ts_match:
                entry["start_time"] = cls._parse_timestamp(ts_match.group(1))

            # Try each GPS pattern
            for pattern in [cls.DJI_PATTERN, cls.DJI_ALT_PATTERN, cls.GENERIC_PATTERN]:
                gps_match = pattern.search(block_text)
                if gps_match:
                    entry["lat"] = float(gps_match.group(1))
                    entry["lon"] = float(gps_match.group(2))
                    entry["alt"] = float(gps_match.group(3))
                    break

            if entry["lat"] is not None:
                entries.append(entry)

        logger.info(f"Parsed {len(entries)} GPS entries from SRT: {srt_path}")
        return entries

    @staticmethod
    def _parse_timestamp(ts_str: str) -> float:
        """Convert HH:MM:SS,mmm to seconds as float."""
        ts_str = ts_str.replace(",", ".")
        parts = ts_str.split(":")
        try:
            hours = int(parts[0])
            minutes = int(parts[1])
            seconds = float(parts[2])
            return hours * 3600 + minutes * 60 + seconds
        except (ValueError, IndexError):
            return 0.0


# ── Video Preprocessing ────────────────────────────────────

class VideoPreprocessor:
    """
    Handle video-to-image extraction using ffmpeg, with intelligent
    frame selection (adaptive FPS, sharpness filtering) and optional
    GPS geotagging from companion SRT files.
    """

    @staticmethod
    def find_matching_srt(video_path: str, all_file_paths: list[str]) -> str | None:
        """
        Find a companion .srt file matching the video filename.
        E.g. DJI_0123.mp4 → DJI_0123.srt
        """
        video_stem = Path(video_path).stem
        for fpath in all_file_paths:
            if Path(fpath).suffix.lower() in SRT_EXTENSIONS:
                if Path(fpath).stem == video_stem:
                    return fpath
        return None

    @staticmethod
    def calculate_extraction_fps(
        video_duration: float,
        target_frames: int,
        native_fps: float = 30.0,
    ) -> float:
        """
        Calculate the optimal extraction FPS to hit target_frames
        from a video of the given duration.

        Clamps between MIN_EXTRACT_FPS and MAX_EXTRACT_FPS,
        and never exceeds the native FPS.
        """
        if video_duration <= 0:
            return MIN_EXTRACT_FPS

        ideal_fps = target_frames / video_duration

        # Clamp to reasonable bounds
        fps = max(MIN_EXTRACT_FPS, min(ideal_fps, MAX_EXTRACT_FPS))

        # Never exceed native FPS (would create duplicates)
        fps = min(fps, native_fps)

        logger.info(
            f"FPS calculation: {video_duration:.1f}s video, "
            f"target={target_frames} frames, ideal={ideal_fps:.1f}fps, "
            f"clamped={fps:.1f}fps → ~{int(video_duration * fps)} frames"
        )
        return fps

    @staticmethod
    def extract_frames(
        video_path: str,
        output_dir: str,
        quality_preset: str = "medium",
        max_frames: int = 500,
    ) -> list[str]:
        """
        Extract frames from a video file using intelligent selection.

        Strategy:
        1. Probe video for duration/FPS/resolution
        2. Calculate optimal extraction FPS for quality preset
        3. Extract frames at full resolution (no downscaling — ODM handles resize)
        4. Filter out blurry frames using Laplacian variance
        5. Evenly subsample if still over max_frames

        Args:
            video_path: Path to the video file.
            output_dir: Directory to write extracted frames.
            quality_preset: "low", "medium", "high", or "ultra".
            max_frames: Hard ceiling on frame count.

        Returns:
            List of paths to extracted (and filtered) frame images.
        """
        os.makedirs(output_dir, exist_ok=True)

        # ── Step 1: Probe video ──
        probe = VideoProbe.probe(video_path)
        duration = probe.get("duration", 5.0)
        native_fps = probe.get("fps", 30.0)
        width = probe.get("width", 0)
        height = probe.get("height", 0)

        if duration <= 0:
            logger.warning(f"Could not determine video duration, defaulting to 5s")
            duration = 5.0

        # ── Step 2: Calculate smart FPS ──
        target = VIDEO_TARGET_FRAMES.get(quality_preset, 60)
        extract_fps = VideoPreprocessor.calculate_extraction_fps(
            duration, target, native_fps
        )

        expected_frames = int(duration * extract_fps)
        effective_max = min(max_frames, target * 2)  # Allow some headroom

        logger.info(
            f"Extracting from {width}x{height} video: "
            f"fps={extract_fps:.1f}, expected ~{expected_frames} frames, "
            f"max={effective_max}, preset={quality_preset}"
        )

        # ── Step 3: Extract at full resolution ──
        # No scale filter — preserve native 4K resolution.
        # ODM's resize-to parameter handles downscaling appropriately.
        cmd = [
            "ffmpeg",
            "-i", video_path,
            "-vf", f"fps={extract_fps}",
            "-vframes", str(effective_max),
            "-q:v", "1",  # Highest quality JPEG (1 = best)
            "-qmin", "1",
            "-y",  # Overwrite existing
            os.path.join(output_dir, "frame_%05d.jpg"),
        ]

        logger.info(f"Extracting frames: {' '.join(cmd)}")

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=3600,
            )
            if result.returncode != 0:
                logger.error(f"ffmpeg error: {result.stderr}")
                raise RuntimeError(f"ffmpeg failed: {result.stderr[:500]}")
        except subprocess.TimeoutExpired:
            raise RuntimeError("ffmpeg frame extraction timed out after 1 hour")

        # Collect extracted frames
        raw_frames = sorted(
            [
                os.path.join(output_dir, f)
                for f in os.listdir(output_dir)
                if f.startswith("frame_") and f.endswith(".jpg")
            ]
        )

        logger.info(f"Raw extraction: {len(raw_frames)} frames from {video_path}")

        if not raw_frames:
            logger.error("No frames extracted!")
            return []

        # ── Step 4: Sharpness filtering ──
        # Discard the blurriest frames (motion blur from timelapse transitions)
        filtered_frames = filter_blurry_frames(
            raw_frames,
            discard_ratio=BLUR_DISCARD_RATIO,
            min_keep=max(10, target // 3),
        )

        # ── Step 5: Even subsampling if over target ──
        if len(filtered_frames) > effective_max:
            step = len(filtered_frames) / effective_max
            indices = [int(i * step) for i in range(effective_max)]
            filtered_frames = [filtered_frames[i] for i in indices]
            logger.info(f"Subsampled to {len(filtered_frames)} evenly-spaced frames")

        # Clean up discarded frames to save disk space
        kept_set = set(filtered_frames)
        for f in raw_frames:
            if f not in kept_set:
                try:
                    os.remove(f)
                except OSError:
                    pass

        logger.info(
            f"Final frame count: {len(filtered_frames)} "
            f"(from {len(raw_frames)} raw, {quality_preset} preset)"
        )

        return filtered_frames

    @staticmethod
    def geotag_frames(frames: list[str], srt_entries: list[dict]) -> int:
        """
        Write GPS EXIF data into extracted frame images using piexif.
        Interpolates GPS positions based on frame index mapped to SRT timestamps.

        Returns number of frames successfully geotagged.
        """
        if not srt_entries or not frames:
            return 0

        tagged_count = 0

        for i, frame_path in enumerate(frames):
            # Map frame index to SRT entry (linear interpolation)
            srt_index = int(i * len(srt_entries) / len(frames))
            srt_index = min(srt_index, len(srt_entries) - 1)
            entry = srt_entries[srt_index]

            lat = entry.get("lat")
            lon = entry.get("lon")
            alt = entry.get("alt", 0.0)

            if lat is None or lon is None:
                continue

            try:
                _write_gps_exif(frame_path, lat, lon, alt)
                tagged_count += 1
            except Exception as e:
                logger.warning(f"Failed to geotag {frame_path}: {e}")

        logger.info(f"Geotagged {tagged_count}/{len(frames)} frames")
        return tagged_count


def _write_gps_exif(image_path: str, lat: float, lon: float, alt: float) -> None:
    """Write GPS coordinates into an image's EXIF data using piexif."""
    # Load existing EXIF or create empty
    try:
        exif_dict = piexif.load(image_path)
    except Exception:
        exif_dict = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}}

    # Convert decimal degrees to DMS (degrees, minutes, seconds)
    def to_dms(decimal_degrees):
        d = int(abs(decimal_degrees))
        m = int((abs(decimal_degrees) - d) * 60)
        s = int(((abs(decimal_degrees) - d) * 60 - m) * 60 * 10000)
        return ((d, 1), (m, 1), (s, 10000))

    lat_ref = b"N" if lat >= 0 else b"S"
    lon_ref = b"E" if lon >= 0 else b"W"

    gps_ifd = {
        piexif.GPSIFD.GPSLatitudeRef: lat_ref,
        piexif.GPSIFD.GPSLatitude: to_dms(lat),
        piexif.GPSIFD.GPSLongitudeRef: lon_ref,
        piexif.GPSIFD.GPSLongitude: to_dms(lon),
        piexif.GPSIFD.GPSAltitudeRef: 0 if alt >= 0 else 1,
        piexif.GPSIFD.GPSAltitude: (int(abs(alt) * 100), 100),
    }

    exif_dict["GPS"] = gps_ifd
    exif_bytes = piexif.dump(exif_dict)

    # Re-save image with EXIF
    img = Image.open(image_path)
    img.save(image_path, exif=exif_bytes, quality=95)
