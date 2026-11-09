"""Real PDF/OCR and LanceDB/FastEmbed tests using synthetic documents only."""
import base64
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

scratch = tempfile.TemporaryDirectory(prefix="bookorbit-knowledge-")
os.environ["KNOWLEDGE_DIR"] = scratch.name
spec = importlib.util.spec_from_file_location("knowledge_worker", Path(__file__).with_name("worker.py"))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class KnowledgeTests(unittest.TestCase):
    def test_pdf_page_extraction(self):
        import pymupdf
        doc = pymupdf.open()
        doc.new_page().insert_text((40, 80), "Neurons communicate through electrical impulses and chemical synapses.")
        doc.new_page().insert_text((40, 80), "Entropy explains the preferred direction of spontaneous heat flow.")
        result = w.extract_pdf({"data": base64.b64encode(doc.tobytes()).decode()})
        self.assertEqual(len(result["sections"]), 2)
        self.assertEqual(result["sections"][1]["page"], 2)
        self.assertIn("Entropy", result["sections"][1]["text"])
        self.assertEqual(result["unreadablePages"], [])

    def test_scanned_pdf_ocr(self):
        import pymupdf
        source = pymupdf.open()
        source.new_page().insert_text((50, 100), "SCANNED PAGE ABOUT NEURONS", fontsize=20)
        png = source[0].get_pixmap(matrix=pymupdf.Matrix(2, 2)).tobytes("png")
        scan = pymupdf.open()
        scan.new_page().insert_image(source[0].rect, stream=png)
        result = w.extract_pdf({"data": base64.b64encode(scan.tobytes()).decode()})
        self.assertEqual(result["ocrPages"], [1])
        self.assertIn("NEURONS", result["sections"][0]["text"].upper())

    def test_interrupted_embedding_resumes_durable_progress(self):
        from unittest.mock import patch
        engine = w.model()
        data = {"bookId": 7, "fingerprint": "7" * 64, "sections": [{"index": i, "label": f"Part {i}", "text": f"Synthetic neuron discussion number {i}."} for i in range(8)]}
        class Interrupted:
            calls = 0
            def embed(self, texts):
                self.calls += 1
                if self.calls > 1:
                    raise ValueError("simulated worker interruption")
                return engine.embed(texts)
        with patch.object(w, "model", return_value=Interrupted()):
            with self.assertRaises(ValueError):
                w.index(data)
        self.assertEqual(w.conn.execute("SELECT count(*) FROM staged WHERE book_id=7").fetchone()[0], 4)
        self.assertIsNone(w.conn.execute("SELECT * FROM sources WHERE book_id=7").fetchone())
        class Counted:
            embedded = 0
            def embed(self, texts):
                self.embedded += len(texts)
                return engine.embed(texts)
        counted = Counted()
        with patch.object(w, "model", return_value=counted):
            w.index(data)
        self.assertEqual(counted.embedded, 4)
        self.assertEqual(w.conn.execute("SELECT count(*) FROM staged WHERE book_id=7").fetchone()[0], 0)

    def test_real_embeddings_lance_prefilter_hybrid_and_replacement(self):
        for bid, text in [(1, "Neurons communicate using electrical impulses and chemical neurotransmitters across synapses."), (2, "Thermodynamics describes entropy and heat flowing from hot to cold bodies."), (3, "SISTER PRIVATE Neurons communicate across synapses using secret neurotransmitters.")]:
            w.index({"bookId": bid, "fingerprint": str(bid) * 64, "sections": [{"index": 0, "label": "Page 1", "page": 1, "text": text}]})
        allowed = [{"bookId": 1, "fingerprint": "1" * 64}, {"bookId": 2, "fingerprint": "2" * 64}]
        result = w.search({"query": "How do nerve cells send signals?", "allowed": allowed, "mode": "semantic", "limit": 3})
        self.assertEqual(result[0]["book_id"], 1)
        self.assertTrue(all(row["book_id"] != 3 for row in result))
        hybrid = w.search({"query": "entropy", "allowed": allowed, "mode": "hybrid"})
        self.assertEqual(hybrid[0]["book_id"], 2)
        self.assertEqual(w.search({"query": "neurons", "allowed": []}), [])
        # Changed/moved source fingerprint must immediately suppress stale rows.
        self.assertEqual(w.search({"query": "neurons", "allowed": [{"bookId": 1, "fingerprint": "a" * 64}]}), [])
        w.index({"bookId": 1, "fingerprint": "a" * 64, "sections": [{"index": 0, "label": "Replacement", "text": "A replacement passage about galaxies and astronomy."}]})
        self.assertEqual(w.table().count_rows("book_id=1"), 1)
        self.assertEqual(w.search({"query": "neurons", "allowed": [{"bookId": 1, "fingerprint": "1" * 64}]}), [])
        with self.assertRaises(ValueError):
            w.index({"bookId": 1, "fingerprint": "b" * 64, "sections": []})
        self.assertEqual(w.conn.execute("SELECT fingerprint FROM sources WHERE book_id=1").fetchone()[0], "a" * 64)



class ReleaseOneTests(unittest.TestCase):
    def test_pdf_window_only_returns_requested_pages(self):
        import pymupdf
        doc=pymupdf.open()
        for i in range(8): doc.new_page().insert_text((40,80), f"Synthetic content on physical page {i+1}, enough text to avoid OCR.")
        doc.set_toc([[1,"Synthetic chapter",4]])
        result=w.extract_pdf({"op":"pdf_window","data":base64.b64encode(doc.tobytes()).decode(),"startPage":4,"pageCount":2})
        self.assertEqual(result["contents"][0]["page"],4)
        self.assertEqual(result["totalPages"],8)
        self.assertEqual([s["page"] for s in result["sections"]],[4,5])

    def test_persistent_job_pause_retry_and_failure(self):
        w.dispatch({"op":"job_control","bookId":99,"action":"queue","priority":80})
        w.dispatch({"op":"job_control","bookId":99,"action":"pause"})
        with self.assertRaises(ValueError):
            w.index({"bookId":99,"fingerprint":"9"*64,"sections":[{"index":0,"label":"test","text":"Synthetic page text"}]})
        job=next(j for j in w.dispatch({"op":"jobs"}) if j["book_id"]==99)
        self.assertEqual(job["state"],"paused")
        w.dispatch({"op":"job_control","bookId":99,"action":"resume","priority":90})
        w.dispatch({"op":"job_control","bookId":99,"action":"failed","error":"Test failure"})
        job=next(j for j in w.dispatch({"op":"jobs"}) if j["book_id"]==99)
        self.assertEqual(job["error"],"Test failure")
        self.assertGreater(job["retry_at"],0)
        w.dispatch({"op":"job_control","bookId":99,"action":"retry","priority":100})
        self.assertEqual(next(j for j in w.dispatch({"op":"jobs"}) if j["book_id"]==99)["retry_at"],0)

    def test_unrelated_programming_fields_are_not_physics_evidence(self):
        w.index({"bookId":88,"fingerprint":"8"*64,"sections":[{"index":0,"label":"Classes","text":"A class field stores a variable in an object. Programming languages provide methods and class fields."}]})
        allowed=[{"bookId":88,"fingerprint":"8"*64}]
        self.assertEqual(w.search({"query":"electromagnetism Maxwell magnetic fields","allowed":allowed}),[])
        self.assertTrue(w.search({"query":"class variables","allowed":allowed,"mode":"lexical"}))


class ReleaseTwoTests(unittest.TestCase):
    def test_versioned_citation_context_and_stale_denial(self):
        text = " ".join(f"neuron{i}" for i in range(550))
        data = {"bookId": 91, "fingerprint": "c"*64, "sections": [
            {"index": 0, "label": "Page 1", "page": 1, "text": text},
            {"index": 1, "label": "Page 2", "page": 2, "text": "Another unrelated section."}]}
        w.index(data)
        rows = sorted(w.chunks(data),key=lambda r:(r["section"],r["char_start"]))
        args = {"op":"passage","bookId":91,"fingerprint":"c"*64,"passageId":rows[1]["id"],"context":1}
        result = w.dispatch(args)
        self.assertEqual(result["passage"]["id"],rows[1]["id"])
        self.assertEqual([r["id"] for r in result["context"]],[rows[0]["id"],rows[2]["id"]])
        self.assertTrue(all(r["section"]==0 for r in result["context"]))
        self.assertEqual(w.chunks(data)[1]["id"],rows[1]["id"])
        with self.assertRaises(ValueError): w.dispatch({**args,"bookId":92})
        with self.assertRaises(ValueError): w.dispatch({**args,"fingerprint":"d"*64})
        w.index({**data,"fingerprint":"d"*64})
        with self.assertRaises(ValueError): w.dispatch(args)

    def test_source_version_refresh_reuses_only_exact_same_book_text(self):
        from unittest.mock import patch
        data={"bookId":94,"fingerprint":"a"*64,"sections":[{"index":0,"label":"Synthetic","text":"Neurons send chemical and electrical signals across synapses."}]}
        w.index(data)
        with patch.object(w,"model",side_effect=AssertionError("Unchanged text was embedded again")):
            result=w.index({**data,"fingerprint":"b"*64})
        self.assertEqual(result["reusedPassages"],1)
        self.assertEqual(w.conn.execute("SELECT fingerprint FROM sources WHERE book_id=94").fetchone()[0],"b"*64)
        # Same text in another book must not borrow this book's vector cache.
        with patch.object(w,"model",side_effect=ValueError("needs new embeddings")):
            with self.assertRaises(ValueError): w.index({**data,"bookId":95})
        # Changed text in the same book must also be embedded afresh.
        with patch.object(w,"model",side_effect=ValueError("needs new embeddings")):
            with self.assertRaises(ValueError): w.index({**data,"fingerprint":"c"*64,"sections":[{"index":0,"label":"New","text":"A different text about bread and yeast."}]})

    def test_semantic_notes_use_only_current_session_snapshot(self):
        a = "a"*64
        b = a.replace("a","b")
        note = {"id":1,"version":"e"*64,"text":"Neurons communicate using electrical impulses and chemical neurotransmitters across synapses."}
        args = {"op":"search_notes","namespace":a,"items":[note],"query":"How do nerve cells send signals?","mode":"semantic"}
        self.assertEqual(w.dispatch(args)[0]["id"],1)
        # Same annotation id with new text cannot retrieve a cached old version.
        self.assertEqual(w.dispatch({**args,"items":[{**note,"version":"f"*64,"text":"Cooking bread uses wheat flour and yeast."}]}),[])
        self.assertEqual(w.dispatch({**args,"items":[]}),[])
        self.assertEqual(w.dispatch({**args,"namespace":b,"items":[]}),[])
        self.assertIsNone(w.conn.execute("SELECT * FROM sources WHERE book_id=999").fetchone())
        self.assertNotIn("text", [r[1] for r in w.notes_conn.execute("PRAGMA table_info(vectors)")])

    def test_note_vectors_survive_restart_and_remain_account_and_model_scoped(self):
        from unittest.mock import patch
        import numpy as np
        class Engine:
            def embed(self, texts): return [np.array([1.0,0.0]) for _ in texts]
        args = {"namespace":"1"*64,"items":[{"id":123,"version":"a"*64,"text":"synthetic note"}],
                "query":"synthetic","mode":"semantic","snapshotComplete":True}
        with patch.object(w,"model",return_value=Engine()), patch.object(w,"query_vector",return_value=np.array([1.0,0.0])):
            self.assertEqual(w.search_notes(args)[0]["id"],123)
        # Reopen the database and worker module: cached documents need no provider.
        spec = importlib.util.spec_from_file_location("restarted_notes",Path(__file__).with_name("worker.py"))
        restarted = importlib.util.module_from_spec(spec); spec.loader.exec_module(restarted)
        with patch.object(restarted,"query_vector",return_value=np.array([1.0,0.0])), patch.object(restarted,"model",side_effect=AssertionError("document re-embedded")):
            self.assertEqual(restarted.search_notes(args)[0]["id"],123)
            # Account B cannot borrow account A's identical annotation/vector.
            with self.assertRaises(AssertionError): restarted.search_notes({**args,"namespace":"2"*64})
            # Edited content must not reuse an old vector, even with a bad version.
            with self.assertRaises(AssertionError): restarted.search_notes({**args,"items":[{**args["items"][0],"text":"edited"}]})
            self.assertEqual(restarted.search_notes({**args,"items":[]}),[])
        self.assertEqual(restarted.notes_conn.execute("SELECT count(*) FROM vectors WHERE namespace=?",("1"*64,)).fetchone()[0],0)
        # Each model identity uses its own annotation database directory.
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,{"KNOWLEDGE_DIR":directory,"EMBED_REVISION":"different"}):
            other = importlib.util.module_from_spec(spec); spec.loader.exec_module(other)
            self.assertNotEqual(other.IDENTITY,w.IDENTITY)
            self.assertEqual(other.notes_conn.execute("SELECT count(*) FROM vectors").fetchone()[0],0)
            other.notes_conn.close(); other.conn.close()
        restarted.notes_conn.close(); restarted.conn.close()



class PdfLimitTests(unittest.TestCase):
    def test_bounded_pdf_limit_configuration(self):
        from unittest.mock import patch
        with patch.dict(os.environ, {"PDF_MAX_MIB":"128"}):
            self.assertEqual(w.pdf_limit_bytes(),128*1024*1024)
        for value in ("0","129","NaN","1.5"):
            with patch.dict(os.environ,{"PDF_MAX_MIB":value}):
                with self.assertRaises(ValueError): w.pdf_limit_bytes()


if __name__ == "__main__":
    unittest.main()
