"""
ComfyUI Data Manager
====================
Custom node pack providing an interactive Excel-like grid
for managing structured data inside ComfyUI workflows.

Included nodes:
  - DataManagerNode      : main grid with column schema + rows
  - ColumnExtractorNode  : extracts a single typed value from a row
  - RowIteratorNode      : iterates over all rows for batch processing
"""

from .nodes.data_manager import DataManagerNode
from .nodes.column_extractor import (
    ColumnExtractorNode,
    ExtractStringNode,
    ExtractIntNode,
    ExtractFloatNode,
    ExtractBoolNode,
    ExtractSelectNode,
    ExtractImagePathNode,
    ExtractAudioPathNode,
    ExtractVideoPathNode,
)
from .nodes.row_iterator import RowIteratorNode

# ── Custom API route: list images in the input folder ──────────────────────
# Exposes GET /dm/list_inputs → JSON array of filenames
# Used by the frontend as a reliable fallback over /object_info/LoadImage
try:
    from pathlib import Path
    from aiohttp import web

    async def _list_input_images(request):
        """Returns image and audio files from the ComfyUI input folder."""
        SUPPORTED_EXTS = {
            ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif",
            ".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".opus", ".weba",
            ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".wmv",
        }
        try:
            import folder_paths  # ComfyUI internal module
            input_dir = Path(folder_paths.get_input_directory())
        except ImportError:
            this_dir  = Path(__file__).parent
            input_dir = this_dir.parent.parent / "input"

        results = []
        if input_dir.exists():
            for f in sorted(input_dir.rglob("*")):
                if f.suffix.lower() in SUPPORTED_EXTS and f.is_file():
                    rel = f.relative_to(input_dir)
                    results.append(str(rel).replace("\\", "/"))

        return web.json_response(results)

    async def _list_audio_files(request):
        """Returns only audio files from the ComfyUI input folder."""
        AUDIO_EXTS = {".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".opus", ".weba"}
        try:
            import folder_paths
            input_dir = Path(folder_paths.get_input_directory())
        except ImportError:
            this_dir  = Path(__file__).parent
            input_dir = this_dir.parent.parent / "input"

        results = []
        if input_dir.exists():
            for f in sorted(input_dir.rglob("*")):
                if f.suffix.lower() in AUDIO_EXTS and f.is_file():
                    rel = f.relative_to(input_dir)
                    results.append(str(rel).replace("\\", "/"))
        return web.json_response(results)

    async def _list_video_files(request):
        """Returns only video files from the ComfyUI input folder."""
        VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".wmv"}
        try:
            import folder_paths
            input_dir = Path(folder_paths.get_input_directory())
        except ImportError:
            input_dir = Path(__file__).parent.parent.parent / "input"
        results = []
        if input_dir.exists():
            for f in sorted(input_dir.rglob("*")):
                if f.suffix.lower() in VIDEO_EXTS and f.is_file():
                    rel = f.relative_to(input_dir)
                    results.append(str(rel).replace("\\", "/"))
        return web.json_response(results)

    async def _video_thumbnail(request):
        """
        Extracts and caches a JPEG thumbnail from the first frame of a video.
        Query params: filename, subfolder (optional)
        Tries OpenCV first, then ffmpeg subprocess as fallback.
        Thumbnail is cached as <video>.dm_thumb.jpg next to the source file.
        """
        filename  = request.rel_url.query.get("filename", "")
        subfolder = request.rel_url.query.get("subfolder", "")
        if not filename:
            return web.Response(status=400, text="filename required")
        try:
            import folder_paths
            input_dir = Path(folder_paths.get_input_directory())
        except ImportError:
            input_dir = Path(__file__).parent.parent.parent / "input"

        video_path = (input_dir / subfolder / filename) if subfolder else (input_dir / filename)
        if not video_path.is_file():
            return web.Response(status=404, text="file not found")

        thumb_path = video_path.with_suffix(".dm_thumb.jpg")
        if thumb_path.exists():
            return web.FileResponse(thumb_path)

        # Try OpenCV
        try:
            import cv2
            cap = cv2.VideoCapture(str(video_path))
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ret, frame = cap.read()
            cap.release()
            if ret:
                h, w = frame.shape[:2]
                scale = min(1.0, 320 / w)
                if scale < 1.0:
                    frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
                cv2.imwrite(str(thumb_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                return web.FileResponse(thumb_path)
        except Exception as e:
            print(f"[DataManager] cv2 thumbnail failed: {e}")

        # Fallback: ffmpeg
        try:
            import subprocess
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(video_path),
                 "-vframes", "1", "-vf", "scale=320:-1",
                 "-f", "image2", str(thumb_path)],
                capture_output=True, timeout=15
            )
            if thumb_path.exists():
                return web.FileResponse(thumb_path)
        except Exception as e:
            print(f"[DataManager] ffmpeg thumbnail failed: {e}")

        return web.Response(status=500, text="could not extract thumbnail")

    async def _audio_duration(request):
        """Returns the duration in seconds for an audio file in the input folder.
        Query params: filename, subfolder (optional)
        Response: { "duration": 42.3 } or { "duration": null } on error.
        """
        filename  = request.rel_url.query.get("filename", "")
        subfolder = request.rel_url.query.get("subfolder", "")
        if not filename:
            return web.json_response({"duration": None})
        try:
            import folder_paths
            input_dir = Path(folder_paths.get_input_directory())
        except ImportError:
            input_dir = Path(__file__).parent.parent.parent / "input"
        full = input_dir / subfolder / filename if subfolder else input_dir / filename
        if not full.is_file():
            return web.json_response({"duration": None})
        # Try mutagen first (lightweight, no decode needed)
        try:
            from mutagen import File as MutagenFile
            audio = MutagenFile(str(full))
            if audio is not None and audio.info is not None:
                return web.json_response({"duration": float(audio.info.length)})
        except Exception:
            pass
        # Fallback: wave module for WAV files
        try:
            import wave
            with wave.open(str(full)) as wf:
                dur = wf.getnframes() / wf.getframerate()
                return web.json_response({"duration": dur})
        except Exception:
            pass
        return web.json_response({"duration": None})

    from server import PromptServer
    # api.fetchApi("/dm/...") in the browser sends GET /api/dm/...
    # so we register on /api/dm/... in the aiohttp router.
    PromptServer.instance.app.router.add_get("/api/dm/list_inputs", _list_input_images)
    PromptServer.instance.app.router.add_get("/api/dm/list_audio",   _list_audio_files)
    PromptServer.instance.app.router.add_get("/api/dm/list_video",   _list_video_files)
    PromptServer.instance.app.router.add_get("/api/dm/duration",     _audio_duration)
    PromptServer.instance.app.router.add_get("/api/dm/thumbnail",    _video_thumbnail)

except Exception as _e:
    print(f"[DataManager] WARNING: could not register route /dm/list_inputs: {_e}")

# ── Class name → Python class mapping ──────────────────────────────────────
NODE_CLASS_MAPPINGS = {
    "DataManagerNode":      DataManagerNode,
    "ColumnExtractorNode":  ColumnExtractorNode,
    "ExtractStringNode":    ExtractStringNode,
    "ExtractIntNode":       ExtractIntNode,
    "ExtractFloatNode":     ExtractFloatNode,
    "ExtractBoolNode":      ExtractBoolNode,
    "ExtractSelectNode":    ExtractSelectNode,
    "ExtractImagePathNode": ExtractImagePathNode,
    "ExtractAudioPathNode": ExtractAudioPathNode,
    "ExtractVideoPathNode": ExtractVideoPathNode,
    "RowIteratorNode":      RowIteratorNode,
}

# ── Human-readable names shown in ComfyUI UI ────────────────────────────────
NODE_DISPLAY_NAME_MAPPINGS = {
    "DataManagerNode":      "📊 Data Manager",
    "ColumnExtractorNode":  "🔍 Column Extractor",
    "ExtractStringNode":    "🔤 Extract String",
    "ExtractIntNode":       "🔢 Extract Int",
    "ExtractFloatNode":     "🔣 Extract Float",
    "ExtractBoolNode":      "✅ Extract Bool",
    "ExtractSelectNode":    "🔽 Extract Select",
    "ExtractImagePathNode": "🖼️ Extract Image Path",
    "ExtractAudioPathNode": "🎵 Extract Audio",
    "ExtractVideoPathNode": "🎬 Extract Video",
    "RowIteratorNode":      "🔄 Row Iterator",
}

# ── JS folder for frontend (grid widget) ───────────────────────────────
WEB_DIRECTORY = "./web/js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
