"""Serialization helpers — strip/convert BSON-only types so FastAPI never chokes."""
from __future__ import annotations
from typing import Any


def _is_objectid(v: Any) -> bool:
    try:
        from bson import ObjectId  # type: ignore
        return isinstance(v, ObjectId)
    except Exception:
        return False


def clean(value: Any) -> Any:
    """Recursively convert ObjectId -> str and drop any other non-JSON bson types."""
    if value is None:
        return None
    if _is_objectid(value):
        return str(value)
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k == "_id":
                continue
            out[k] = clean(v)
        return out
    if isinstance(value, list):
        return [clean(v) for v in value]
    if isinstance(value, tuple):
        return [clean(v) for v in value]
    return value
