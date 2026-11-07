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


if __name__ == "__main__":
    unittest.main()
