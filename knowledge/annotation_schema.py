"""Versioned LanceDB contracts for atomic annotations; not wired to production yet.

No implicit database access or embedding calls. BookOrbit owns the source records.
Identity/authorization columns are application-enforced, not database ACLs.
"""
import hashlib
import json
import re

import pyarrow as pa

SCHEMA_VERSION = 1
UNITS_TABLE = "annotation_units_v1"
LINKS_TABLE = "annotation_passage_links_v1"


def _hex(value, length):
    if not isinstance(value, str) or not re.fullmatch(f"[a-f0-9]{{{length}}}", value):
        raise ValueError("Invalid annotation identity")
    return value


def _positive(value):
    if type(value) is not int or value <= 0:
        raise ValueError("Expected positive native identifier")
    return value


def unit_id(owner_scope, annotation_id, kind):
    """Stable across content edits; scoped so identical native IDs cannot collide."""
    _hex(owner_scope, 64)
    _positive(annotation_id)
    if kind not in {"highlight", "note"}:
        raise ValueError("Invalid annotation unit kind")
    return hashlib.sha256(json.dumps([owner_scope, annotation_id, kind]).encode()).hexdigest()


def unit_schema(dimensions, embedding_identity):
    if type(dimensions) is not int or not 1 <= dimensions <= 8192:
        raise ValueError("Invalid embedding dimensions")
    _hex(embedding_identity, 16)
    required = [
        ("id", pa.string()),
        ("owner_scope", pa.string()),
        ("annotation_id", pa.int64()),
        ("kind", pa.string()),
        ("book_id", pa.int64()),
        ("library_id", pa.int64()),
        ("annotation_version", pa.string()),
        ("source_version", pa.string()),
        ("text", pa.string()),
        ("text_sha256", pa.string()),
        ("embedding_text_sha256", pa.string()),
        ("embedding_input_mode", pa.string()),
        ("embedding_provenance", pa.string()),
        ("vector", pa.list_(pa.float32(), dimensions)),
        ("indexed_at", pa.timestamp("ms", tz="UTC")),
    ]
    location = [
        ("reader_page", pa.int64()),
        ("reader_cfi", pa.string()),
        ("reader_chapter", pa.string()),
        ("reader_chapter_index", pa.int64()),
        ("reader_file_id", pa.int64()),
        ("reader_origin", pa.string()),
        ("reader_position_status", pa.string()),
        ("source_created_at", pa.string()),
        ("reused_passage_id", pa.string()),
    ]
    return pa.schema(
        [pa.field(name, dtype, nullable=False) for name, dtype in required]
        + [pa.field(name, dtype) for name, dtype in location],
        metadata={
            b"annotation_schema_version": str(SCHEMA_VERSION).encode(),
            b"embedding_identity": embedding_identity.encode(),
            b"embedding_dimensions": str(dimensions).encode(),
            b"atomic_unit_policy": b"native-highlight-or-note-v1:no-silent-truncation",
        },
    )


def link_schema():
    # Separate many-to-many mapping; never attach user ownership to shared book rows.
    fields = [
        ("id", pa.string(), False),
        ("owner_scope", pa.string(), False),
        ("unit_id", pa.string(), False),
        ("annotation_version", pa.string(), False),
        ("book_id", pa.int64(), False),
        ("source_version", pa.string(), False),
        ("passage_id", pa.string(), False),
        ("passage_index_identity", pa.string(), False),
        ("match_method", pa.string(), False),
        ("section", pa.int64(), False),
        ("char_start", pa.int64(), True),
        ("char_end", pa.int64(), True),
    ]
    return pa.schema([pa.field(n, t, nullable=nullable) for n, t, nullable in fields],
                     metadata={b"annotation_link_schema_version": b"1"})


def ensure_tables(db, dimensions, embedding_identity):
    """Explicit creation only; refuse incompatible tables rather than overwrite."""
    expected = {UNITS_TABLE: unit_schema(dimensions, embedding_identity), LINKS_TABLE: link_schema()}
    names = set(db.list_tables().tables)
    # Validate all existing schemas before creating anything.
    for name, schema in expected.items():
        if name in names and not db.open_table(name).schema.equals(schema, check_metadata=True):
            raise ValueError("Incompatible annotation schema; use a new version/model directory")
    return {name: db.open_table(name) if name in names else db.create_table(name, schema=schema)
            for name, schema in expected.items()}


def authorized_filter(owner_scope, current_books, current_units):
    """Trusted server inputs only. Missing live candidates always deny all rows.

    Book candidates: (native book ID, source fingerprint).
    Unit candidates: (scoped stable unit ID, current annotation version).
    Permissions still require a final live check after retrieval.
    """
    owner = _hex(owner_scope, 64)
    books = [f"(book_id={_positive(bid)} AND source_version='{_hex(version,64)}')"
             for bid, version in current_books]
    units = [f"(id='{_hex(uid,64)}' AND annotation_version='{_hex(version,64)}')"
             for uid, version in current_units]
    if not books or not units:
        return "false"
    return f"owner_scope='{owner}' AND (" + " OR ".join(books) + ") AND (" + " OR ".join(units) + ")"
