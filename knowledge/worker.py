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
import time

os.umask(0o077)
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
from embeddings import EmbeddingConfig, VoyageEmbedding

EMBEDDING = EmbeddingConfig.from_env()
MODEL = EMBEDDING.model
REVISION = EMBEDDING.revision
ROOT = Path(os.environ.get("KNOWLEDGE_DIR", "data/knowledge"))
ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
IDENTITY = EMBEDDING.identity
DBROOT = ROOT / IDENTITY
DBROOT.mkdir(exist_ok=True)
conn = sqlite3.connect(DBROOT / "sources.sqlite3")
conn.execute("CREATE TABLE IF NOT EXISTS sources(book_id INTEGER PRIMARY KEY, fingerprint TEXT, chunks INTEGER)")
conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(id UNINDEXED,book_id UNINDEXED,fingerprint UNINDEXED,text)")
conn.execute("CREATE TABLE IF NOT EXISTS staged(id TEXT PRIMARY KEY, book_id INTEGER, vector TEXT)")
conn.execute("PRAGMA journal_mode=WAL")
conn.execute("CREATE TABLE IF NOT EXISTS jobs(book_id INTEGER PRIMARY KEY, fingerprint TEXT, state TEXT, priority INTEGER DEFAULT 0, total INTEGER DEFAULT 0, completed INTEGER DEFAULT 0, error TEXT, updated REAL, retry_at REAL DEFAULT 0, embedding_seconds REAL DEFAULT 0)")
engine = None
vectors = None


def model():
    global engine
    if engine is None:
        if EMBEDDING.provider == "voyage":
            engine = VoyageEmbedding(EMBEDDING)
        else:
            from fastembed import TextEmbedding
            engine = TextEmbedding(model_name=MODEL, cache_dir=os.environ.get("EMBED_CACHE_DIR", str(ROOT / "models")), threads=1)
    return engine


def query_vector(text):
    embeddings = model().query_embed([text]) if EMBEDDING.provider == "voyage" else model().embed([text])
    return next(iter(embeddings))


def store():
    global vectors
    if vectors is None:
        import lancedb
        vectors = lancedb.connect(str(DBROOT / "lancedb"))
    return vectors


def table():
    db = store()
    return db.open_table("passages") if "passages" in db.table_names() else None


def pdf_limit_bytes():
    raw = os.environ.get("PDF_MAX_MIB", "80")
    if not raw.isdigit() or not 1 <= int(raw) <= 128:
        raise ValueError("PDF_MAX_MIB must be an integer between1 and128")
    return int(raw) * 1024 * 1024


def extract_pdf(data):
    import pymupdf
    raw = base64.b64decode(data["data"], validate=True)
    if len(raw) > pdf_limit_bytes():
        raise ValueError("PDF exceeds configured MiB limit")
    sections = []
    ocr_pages = []
    unavailable = []
    with pymupdf.open(stream=raw, filetype="pdf") as doc:
        if doc.needs_pass:
            raise ValueError("Encrypted PDF requires an unlocked source")
        if len(doc) > 2000:
            raise ValueError("PDF exceeds 2000-page extraction limit")
        chars = 0
        start = max(0, int(data.get("startPage", 1)) - 1)
        stop = min(len(doc), start + int(data.get("pageCount", 5))) if data.get("op") == "pdf_window" else len(doc)
        if start >= len(doc): raise ValueError("Page outside PDF")
        total_pages = len(doc)
        outline = doc.get_toc()
        for index in range(start, stop):
            page = doc[index]
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
    return {"contents": [{"level":r[0],"title":r[1],"page":r[2]} for r in outline[:200]], "contentsTruncated":len(outline)>200,"totalPages": total_pages, "sections": sections, "ocrPages": ocr_pages, "unreadablePages": unavailable,
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
            # Repair inputs that cannot be embedded without changing ordinary
            # chunk IDs or rebuilding the existing index. PDF layout whitespace
            # and long Unicode tokens can exceed the provider cap at <200 words.
            bounded = byte_bounded_spans(content)
            for offset, part in bounded:
                part_lo = lo + offset
                digest = hashlib.sha256(part.encode()).hexdigest()
                key = f'{data["bookId"]}:{data["fingerprint"]}:{section["index"]}:{part_lo}'
                if len(content.encode()) > 30_000:
                    # A shortened passage must never reuse an older staged
                    # vector with the same start but different embedding input.
                    key += f':byte-v2:{digest}'
                rows.append({"id": hashlib.sha256(key.encode()).hexdigest(), "book_id": int(data["bookId"]),
                         "fingerprint": data["fingerprint"], "section": section["index"], "label": section["label"],
                         "page": section.get("page", 0), "char_start": part_lo, "char_end": part_lo + len(part), "text": part,
                         "sha256": digest})
            if end == len(words):
                break
    if len(rows) > 25_000:
        raise ValueError("Book exceeds 25000 passage limit")
    return rows


def byte_bounded_spans(text, limit=30_000):
    """Lossless UTF-8 bounds with source offsets; omit whitespace-only spans."""
    raw = text.encode()
    offset = 0
    while raw:
        end = min(limit, len(raw))
        while end < len(raw) and raw[end] & 0xC0 == 0x80:
            end -= 1
        part = raw[:end].decode()
        # Prefer a complete word when possible, but split pathological long
        # tokens rather than truncating or rejecting the rest of the book.
        if end < len(raw):
            boundary = max(part.rfind(" "), part.rfind("\n"), part.rfind("\t"))
            if boundary > len(part) // 2:
                part = part[:boundary + 1]
                end = len(part.encode())
        if part.strip():
            yield offset, part
        offset += len(part)
        raw = raw[end:]


def index(data):
    book_id = int(data["bookId"])
    rows = chunks(data)
    if not rows:
        raise ValueError("No extractable text; scanned pages may require OCR")
    with conn:
        conn.execute("INSERT OR IGNORE INTO jobs(book_id,fingerprint,state,updated) VALUES(?,?,?,?)", (book_id,data["fingerprint"],"queued",time.time()))
        job = conn.execute("SELECT state,fingerprint FROM jobs WHERE book_id=?", (book_id,)).fetchone()
        if job[0] == "paused": raise ValueError("Indexing paused")
        conn.execute("UPDATE jobs SET fingerprint=?,state='running',total=?,updated=?,error=NULL WHERE book_id=?", (data["fingerprint"],len(rows),time.time(),book_id))
    # Durable per-chunk progress lets large books resume after interruption.
    existing = dict(conn.execute("SELECT id, vector FROM staged WHERE book_id=?", (book_id,)))
    for row in rows:
        if row["id"] in existing:
            row["vector"] = json.loads(existing[row["id"]])
    # A native metadata update changes the source version, but unchanged passage
    # text must not force another whole-book embedding run. Reuse vectors only
    # from this same book/model index and exact text checksums, never old text.
    reused = 0
    previous = table()
    if previous is not None:
        old_vectors = {r["sha256"]:r["vector"] for r in previous.search().select(["sha256","vector"]).where(f"book_id={book_id}").limit(25_000).to_list()}
        for row in rows:
            if "vector" not in row and row["sha256"] in old_vectors:
                row["vector"] = old_vectors[row["sha256"]]
                reused += 1
    pending = [r for r in rows if "vector" not in r]
    with conn:
        conn.execute("UPDATE jobs SET completed=? WHERE book_id=?", (len(rows)-len(pending),book_id))
    print(f"[Knowledge] indexing book={book_id} passages={len(rows)}", file=sys.stderr, flush=True)
    batch_size = 128 if EMBEDDING.provider == "voyage" else 4
    for start in range(0, len(pending), batch_size):
        if conn.execute("SELECT state FROM jobs WHERE book_id=?", (book_id,)).fetchone()[0] == "paused":
            raise ValueError("Indexing paused")
        batch = pending[start:start + batch_size]
        began = time.monotonic()
        embeddings = list(model().embed([r["text"] for r in batch]))
        for row, vector in zip(batch, embeddings, strict=True):
            row["vector"] = vector.tolist()
        with conn:
            conn.executemany("INSERT OR REPLACE INTO staged VALUES(?,?,?)", [(r["id"], book_id, json.dumps(r["vector"])) for r in batch])
            conn.execute("UPDATE jobs SET completed=?,embedding_seconds=embedding_seconds+?,updated=? WHERE book_id=?", (len(rows)-len(pending)+start+len(batch),time.monotonic()-began,time.time(),book_id))
    if conn.execute("SELECT state FROM jobs WHERE book_id=?", (book_id,)).fetchone()[0] == "paused": raise ValueError("Indexing paused")
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
        conn.execute("UPDATE jobs SET state='complete',completed=total,error=NULL,updated=? WHERE book_id=?", (time.time(),book_id))
    return {"bookId": book_id, "passages": len(rows), "reusedPassages": reused}


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
        vector = query_vector(data["query"]).tolist()
        semantic = tbl.search(vector).distance_type("cosine").where(where, prefilter=True).limit(100).to_list()
    ignored = set("the a an of to in and or how what why does do is are about explain explaining find passages books my across with from fields field".split())
    tokens = [t for t in re.findall(r"\w+", data["query"].lower(), re.UNICODE) if t not in ignored and len(t)>2][:32]
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
    similarities = {r["id"]: 1-float(r.get("_distance",1)) for r in semantic}
    lexical_ids = {r["id"] for r in lexical}
    ranked = {}
    for group in (semantic, lexical):
        for position, row in enumerate(group):
            key = row["id"]
            current = ranked.setdefault(key, {**{k: v for k, v in row.items() if k not in ("vector", "_distance")}, "score": 0})
            current["semanticSimilarity"] = similarities.get(key)
            current["lexicalMatch"] = key in lexical_ids
            current["score"] += 1 / (60 + position + 1)
    return sorted([r for r in ranked.values() if r["lexicalMatch"] or (r["semanticSimilarity"] or 0) >= EMBEDDING.minimum_similarity], key=lambda r: (-r["score"], r["id"]))[:int(data.get("limit", 10))]


# Separate, model-scoped derived cache; no annotation text or credentials on disk.
# Only the current authenticated snapshot is ever ranked, never cached rows alone.
notes_conn = sqlite3.connect(DBROOT / "annotations.sqlite3")
notes_conn.execute("PRAGMA journal_mode=WAL")
notes_conn.execute("CREATE TABLE IF NOT EXISTS vectors(namespace TEXT, note_id INTEGER, version TEXT, text_hash TEXT, vector TEXT, used REAL, PRIMARY KEY(namespace,note_id))")
annotation_index = None


def atomic_annotations(data):
    global annotation_index
    from annotation_index import AnnotationIndex
    with (DBROOT / "annotation-writer.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if annotation_index is None:
            annotation_index = AnnotationIndex(DBROOT, EMBEDDING, model, query_vector, table, conn, notes_conn)
        if data["op"] == "annotation_sync":
            try: return annotation_index.sync(data)
            except Exception:
                annotation_index.failed(data)
                raise
        if data["op"] == "annotation_finish": return annotation_index.finish(data)
        if data["op"] == "annotation_search": return annotation_index.search(data)
        if data["op"] == "annotation_status": return annotation_index.status(data)
        raise ValueError("Unknown annotation operation")


def search_notes(data):
    namespace = data["namespace"]
    if not re.fullmatch(r"[a-f0-9]{64}", namespace): raise ValueError("Invalid note namespace")
    items = data["items"]
    if len(items) > 500: raise ValueError("Annotation snapshot exceeds 500 notes")
    mode = data.get("mode", "hybrid")
    query = data["query"]
    import numpy as np
    q = None
    current_vectors = {}
    now = time.time()
    with notes_conn:
        notes_conn.execute("DELETE FROM vectors WHERE used < ?", (now - 30*86400,))
        if data.get("snapshotComplete"):
            ids = [int(r["id"]) for r in items]
            if ids:
                notes_conn.execute("DELETE FROM vectors WHERE namespace=? AND note_id NOT IN (" + ",".join("?" for _ in ids) + ")", [namespace,*ids])
            else:
                notes_conn.execute("DELETE FROM vectors WHERE namespace=?", (namespace,))
        # A changed version invalidates the previous vector even on lexical calls.
        for row in items:
            notes_conn.execute("DELETE FROM vectors WHERE namespace=? AND note_id=? AND (version!=? OR text_hash!=?)",
                               (namespace,row["id"],row["version"],hashlib.sha256(row["text"][:4000].encode()).hexdigest()))
    if mode != "lexical" and items:
        q = np.asarray(query_vector(query), dtype=float)
        pending = []
        for row in items:
            cached = notes_conn.execute("SELECT vector FROM vectors WHERE namespace=? AND note_id=? AND version=? AND text_hash=?",
                (namespace,row["id"],row["version"],hashlib.sha256(row["text"][:4000].encode()).hexdigest())).fetchone()
            if cached:
                current_vectors[row["id"]] = np.asarray(json.loads(cached[0]), dtype=float)
            else:
                pending.append(row)
        for start in range(0,len(pending),4):
            batch = pending[start:start+4]
            with notes_conn:
                for row,vector in zip(batch,model().embed([r["text"][:4000] for r in batch]),strict=True):
                    value = np.asarray(vector, dtype=float)
                    current_vectors[row["id"]] = value
                    notes_conn.execute("INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?,?)",
                        (namespace,row["id"],row["version"],hashlib.sha256(row["text"][:4000].encode()).hexdigest(),json.dumps(value.tolist()),now))
        with notes_conn:
            notes_conn.executemany("UPDATE vectors SET used=? WHERE namespace=? AND note_id=?", [(now,namespace,r["id"]) for r in items])
            # Bounded disk retention; eviction only costs later recomputation.
            notes_conn.execute("DELETE FROM vectors WHERE rowid IN (SELECT rowid FROM vectors WHERE namespace=? ORDER BY used DESC,note_id DESC LIMIT -1 OFFSET 4096)", (namespace,))
            notes_conn.execute("DELETE FROM vectors WHERE rowid IN (SELECT rowid FROM vectors ORDER BY used DESC LIMIT -1 OFFSET 16384)")
    tokens = set(re.findall(r"\w+",query.lower())) - set("how do does the a an of and to in my notes about are is".split())
    rows = []
    for row in items:
        similarity = None
        if q is not None:
            vector = current_vectors[row["id"]]
            similarity = float(np.dot(q,vector)/(np.linalg.norm(q)*np.linalg.norm(vector)))
        lexical = len(tokens & set(re.findall(r"\w+",row["text"].lower()))) if mode != "semantic" else 0
        if lexical or (similarity is not None and similarity >= EMBEDDING.minimum_similarity):
            rows.append({"id":row["id"],"version":row["version"],"semanticSimilarity":similarity,
                         "score": (similarity or 0) + min(lexical,5)*0.1})
    return sorted(rows,key=lambda r:(-r["score"],r["id"]))[:int(data.get("limit",10))]


def passage(data):
    from lancedb.query import ColumnOrdering
    bid,fp,pid = int(data["bookId"]),data["fingerprint"],data["passageId"]
    if not re.fullmatch(r"[a-f0-9]{64}",fp) or not re.fullmatch(r"[a-f0-9]{64}",pid):
        raise ValueError("Invalid citation")
    active = conn.execute("SELECT fingerprint FROM sources WHERE book_id=?",(bid,)).fetchone()
    tbl = table()
    if not active or active[0] != fp or tbl is None: raise ValueError("Citation unavailable or stale; search again")
    where = f"book_id={bid} AND fingerprint='{fp}'"
    rows = tbl.search().where(f"{where} AND id='{pid}'").limit(1).to_list()
    if not rows: raise ValueError("Citation unavailable or stale; search again")
    row = rows[0]
    count = min(2,max(0,int(data.get("context",1))))
    # Filter before LIMIT, sorted offsets; never cross section/page boundaries.
    context = []
    if count:
        section = int(row["section"])
        for direction,op,ascending in [("before","<",False),("after",">",True)]:
            adjacent = (tbl.search().where(f"{where} AND section={section} AND char_start{op}{int(row['char_start'])}")
                        .order_by([ColumnOrdering(column_name="char_start",ascending=ascending)]).limit(count).to_list())
            context.extend(adjacent)
    clean = lambda r: {k:v for k,v in r.items() if k != "vector"}
    return {"passage":clean(row),"context":[clean(r) for r in sorted(context,key=lambda r:r["char_start"])]}


def dispatch(data):
    op = data["op"]
    if op in ("annotation_sync", "annotation_finish", "annotation_search", "annotation_status"):
        return atomic_annotations(data)
    if op == "search_notes": return search_notes(data)
    if op == "passage": return passage(data)
    if op == "jobs":
        names = [r[1] for r in conn.execute("PRAGMA table_info(jobs)")]
        return [dict(zip(names,row)) for row in conn.execute("SELECT * FROM jobs")]
    if op == "job_control":
        bid = int(data["bookId"])
        action = data["action"]
        with conn:
            conn.execute("INSERT OR IGNORE INTO jobs(book_id,state,updated) VALUES(?,'queued',?)", (bid,time.time()))
            if action == "pause": conn.execute("UPDATE jobs SET state='paused',updated=? WHERE book_id=?", (time.time(),bid))
            elif action in ("queue","resume","retry"):
                conn.execute("UPDATE jobs SET state=CASE WHEN state='running' THEN state ELSE 'queued' END,priority=?,retry_at=0,error=NULL,updated=? WHERE book_id=?", (int(data.get("priority",100)),time.time(),bid))
                active = conn.execute("SELECT fingerprint,chunks FROM sources WHERE book_id=?", (bid,)).fetchone()
                if active and active[0] == data.get("fingerprint"):
                    conn.execute("UPDATE jobs SET state='complete',completed=?,total=? WHERE book_id=?", (active[1],active[1],bid))
            elif action == "complete":
                conn.execute("UPDATE jobs SET state='complete',total=?,completed=?,error=NULL,updated=? WHERE book_id=?", (int(data["passages"]),int(data["passages"]),time.time(),bid))
            elif action == "start":
                if conn.execute("SELECT state FROM jobs WHERE book_id=?", (bid,)).fetchone()[0] == "paused": raise ValueError("Indexing paused")
                conn.execute("UPDATE jobs SET state='extracting',updated=? WHERE book_id=?", (time.time(),bid))
            elif action == "failed":
                conn.execute("UPDATE jobs SET state='failed',error=?,retry_at=?,updated=? WHERE book_id=? AND state!='paused'", (str(data.get("error","Indexing failed"))[:200],time.time()+900,time.time(),bid))
            else: raise ValueError("Unknown job action")
        return {"bookId":bid,"action":action}
    if op in ("pdf", "pdf_window"):
        return extract_pdf(data)
    if op == "index":
        with (DBROOT / "writer.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return index(data)
    if op == "search":
        return search(data)
    if op == "status":
        return {"model": MODEL, "revision": REVISION, "indexIdentity": IDENTITY,
                "embedding": {"provider": EMBEDDING.provider, "documentModel": MODEL, "queryModel": EMBEDDING.query_model,
                              "dimensions": EMBEDDING.dimensions, "externalContent": EMBEDDING.provider == "voyage",
                              "minimumSimilarity": EMBEDDING.minimum_similarity, "thresholdCalibrated": False},
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
