"""Private derived passage index. JSON-lines IPC; never reads BookOrbit's DB/files.

Only its parent supplies authorized documents/candidate fingerprints. Originals
are never modified. Indexes can be deleted and rebuilt. stdout is protocol only.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

os.umask(0o077)
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-small-en-v1.5")
REVISION = os.environ.get("EMBED_REVISION", "1")
ROOT = Path(os.environ.get("KNOWLEDGE_DIR", "data/knowledge"))
ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
IDENTITY = hashlib.sha256(f"{MODEL}:{REVISION}:chunk-v1-200-40".encode()).hexdigest()[:16]
DBROOT = ROOT / IDENTITY
DBROOT.mkdir(exist_ok=True)
conn = sqlite3.connect(DBROOT / "sources.sqlite3")
conn.execute("CREATE TABLE IF NOT EXISTS sources(book_id INTEGER PRIMARY KEY, fingerprint TEXT, chunks INTEGER)")
conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(id UNINDEXED,book_id UNINDEXED,fingerprint UNINDEXED,text)")
conn.execute("CREATE TABLE IF NOT EXISTS staged(id TEXT PRIMARY KEY, book_id INTEGER, vector TEXT)")
engine = None
vectors = None


def model():
    global engine
    if engine is None:
        from fastembed import TextEmbedding
        engine = TextEmbedding(model_name=MODEL, cache_dir=os.environ.get("EMBED_CACHE_DIR", str(ROOT / "models")), threads=1)
    return engine


def store():
    global vectors
    if vectors is None:
        import lancedb
        vectors = lancedb.connect(str(DBROOT / "lancedb"))
    return vectors


def table():
    db = store()
    return db.open_table("passages") if "passages" in db.table_names() else None


def extract_pdf(data):
    import pymupdf
    raw = base64.b64decode(data["data"], validate=True)
    if len(raw) > 80 * 1024 * 1024:
        raise ValueError("PDF exceeds 80 MiB limit")
    sections = []
    ocr_pages = []
    unavailable = []
    with pymupdf.open(stream=raw, filetype="pdf") as doc:
        if doc.needs_pass:
            raise ValueError("Encrypted PDF requires an unlocked source")
        if len(doc) > 2000:
            raise ValueError("PDF exceeds 2000-page extraction limit")
        chars = 0
        for index, page in enumerate(doc):
            text = page.get_text(sort=True)
            if len(text.strip()) < 30:
                if os.environ.get("PDF_OCR", "1") == "1":
                    try:
                        tp = page.get_textpage_ocr(language=os.environ.get("OCR_LANGUAGES", "eng"), dpi=150, full=True)
                        text = page.get_text(textpage=tp, sort=True)
                        ocr_pages.append(index + 1)
                    except (RuntimeError, ImportError):
                        unavailable.append(index + 1)
                else:
                    unavailable.append(index + 1)
            chars += len(text)
            if chars > 25_000_000:
                raise ValueError("PDF exceeds 25 million extracted characters")
            sections.append({"index": index, "label": f"Page {index + 1}", "page": index + 1, "text": text})
    return {"sections": sections, "ocrPages": ocr_pages, "unreadablePages": unavailable,
            "sha256": hashlib.sha256(raw).hexdigest()}


def chunks(data):
    rows = []
    for section in data["sections"]:
        text = section["text"]
        words = list(re.finditer(r"\S+", text))
        for start in range(0, len(words), 160):
            end = min(start + 200, len(words))
            lo, hi = words[start].start(), words[end - 1].end()
            content = text[lo:hi]
            key = f'{data["bookId"]}:{data["fingerprint"]}:{section["index"]}:{lo}'
            rows.append({"id": hashlib.sha256(key.encode()).hexdigest(), "book_id": int(data["bookId"]),
                         "fingerprint": data["fingerprint"], "section": section["index"], "label": section["label"],
                         "page": section.get("page", 0), "char_start": lo, "char_end": hi, "text": content,
                         "sha256": hashlib.sha256(content.encode()).hexdigest()})
            if end == len(words):
                break
    if len(rows) > 25_000:
        raise ValueError("Book exceeds 25000 passage limit")
    return rows


def index(data):
    book_id = int(data["bookId"])
    rows = chunks(data)
    if not rows:
        raise ValueError("No extractable text; scanned pages may require OCR")
    # Durable per-chunk progress lets large books resume after interruption.
    existing = dict(conn.execute("SELECT id, vector FROM staged WHERE book_id=?", (book_id,)))
    for row in rows:
        if row["id"] in existing:
            row["vector"] = json.loads(existing[row["id"]])
    pending = [r for r in rows if "vector" not in r]
    print(f"[Knowledge] indexing book={book_id} passages={len(rows)}", file=sys.stderr, flush=True)
    for start in range(0, len(pending), 4):
        batch = pending[start:start + 4]
        embeddings = list(model().embed([r["text"] for r in batch]))
        for row, vector in zip(batch, embeddings, strict=True):
            row["vector"] = vector.tolist()
        with conn:
            conn.executemany("INSERT OR REPLACE INTO staged VALUES(?,?,?)", [(r["id"], book_id, json.dumps(r["vector"])) for r in batch])
    db = store()
    tbl = table()
    if tbl is None:
        db.create_table("passages", data=rows)
    else:
        (tbl.merge_insert("id").when_matched_update_all().when_not_matched_insert_all()
         .when_not_matched_by_source_delete(f"book_id = {book_id}").execute(rows))
    with conn:
        conn.execute("DELETE FROM passages WHERE book_id=?", (book_id,))
        conn.executemany("INSERT INTO passages VALUES(?,?,?,?)", [(r["id"], book_id, r["fingerprint"], r["text"]) for r in rows])
        conn.execute("INSERT OR REPLACE INTO sources VALUES(?,?,?)", (book_id, data["fingerprint"], len(rows)))
        conn.execute("DELETE FROM staged WHERE book_id=?", (book_id,))
    return {"bookId": book_id, "passages": len(rows)}


def search(data):
    allowed = []
    for row in data["allowed"]:
        book_id, fp = int(row["bookId"]), row["fingerprint"]
        if book_id <= 0 or not re.fullmatch(r"[a-f0-9]{64}", fp):
            raise ValueError("Invalid candidate fingerprint")
        active = conn.execute("SELECT fingerprint FROM sources WHERE book_id=?", (book_id,)).fetchone()
        if active and active[0] == fp:
            allowed.append((book_id, fp))
    tbl = table()
    if not allowed or tbl is None:
        return []
    where = " OR ".join(f"(book_id={bid} AND fingerprint='{fp}')" for bid, fp in allowed)
    mode = data.get("mode", "hybrid")
    semantic = []
    lexical = []
    if mode != "lexical":
        vector = next(model().embed([data["query"]])).tolist()
        semantic = tbl.search(vector).distance_type("cosine").where(where, prefilter=True).limit(100).to_list()
    tokens = re.findall(r"\w+", data["query"], re.UNICODE)[:32]
    if mode != "semantic" and tokens:
        expr = " OR ".join('"' + t + '"' for t in tokens)
        valid = {(bid, fp) for bid, fp in allowed}
        # Authorization is applied inside the FTS query before LIMIT/ranking.
        clauses = " OR ".join("(book_id=? AND fingerprint=?)" for _ in allowed)
        params = [x for pair in allowed for x in pair]
        ids = conn.execute(f"SELECT id, book_id, fingerprint FROM passages WHERE passages MATCH ? AND ({clauses}) ORDER BY rank LIMIT 100", [expr, *params]).fetchall()
        ids = [r[0] for r in ids if (int(r[1]), r[2]) in valid]
        if ids:
            id_filter = "id IN (" + ",".join(f"'{i}'" for i in ids) + ")"
            by_id = {r["id"]: r for r in tbl.search().where(f"({where}) AND {id_filter}").limit(100).to_list()}
            lexical = [by_id[i] for i in ids if i in by_id]
    ranked = {}
    for group in (semantic, lexical):
        for position, row in enumerate(group):
            key = row["id"]
            current = ranked.setdefault(key, {**{k: v for k, v in row.items() if k not in ("vector", "_distance")}, "score": 0})
            current["score"] += 1 / (60 + position + 1)
    return sorted(ranked.values(), key=lambda r: (-r["score"], r["id"]))[:int(data.get("limit", 10))]


def dispatch(data):
    op = data["op"]
    if op == "pdf":
        return extract_pdf(data)
    if op == "index":
        with (DBROOT / "writer.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return index(data)
    if op == "search":
        return search(data)
    if op == "status":
        return {"model": MODEL, "revision": REVISION, "indexIdentity": IDENTITY,
                "building": [{"bookId": r[0], "completedPassages": r[1]} for r in conn.execute("SELECT book_id,count(*) FROM staged GROUP BY book_id")],
                "sources": [{"bookId": r[0], "fingerprint": r[1], "passages": r[2]} for r in conn.execute("SELECT * FROM sources")]}
    raise ValueError("Unknown operation")


if __name__ == "__main__":
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = dispatch(request)
            print(json.dumps({"result": result}), flush=True)
        except Exception as error:
            # Avoid echoing document text, credentials or arbitrary paths.
            message = str(error) if isinstance(error, ValueError) else f"Knowledge worker {type(error).__name__}; inspect configuration"
            print(json.dumps({"error": message}), flush=True)
