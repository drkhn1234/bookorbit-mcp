"""Byte-bounded chunk repair; no book content or external provider calls."""
import hashlib
import unittest
from unittest.mock import patch
from test_worker import w
from embeddings import EmbeddingConfig


class ChunkRefinementTests(unittest.TestCase):
    def rows(self, text):
        return w.chunks({"bookId": 183, "fingerprint": "a"*64,
                         "sections": [{"index": 23, "label": "Page 24", "page": 24, "text": text}]})

    def test_normal_chunk_ids_text_and_overlap_are_unchanged(self):
        text = " ".join(f"word{i}" for i in range(401))
        rows = self.rows(text)
        self.assertEqual([len(r["text"].split()) for r in rows], [200, 200, 81])
        self.assertEqual(rows[0]["id"], hashlib.sha256(f'183:{"a"*64}:23:0'.encode()).hexdigest())
        self.assertEqual(rows[0]["text"].split()[-40:], rows[1]["text"].split()[:40])

    def test_pdf_whitespace_is_bounded_with_exact_source_offsets(self):
        text = "first" + " \n"*21000 + "second final"
        rows = self.rows(text)
        self.assertGreater(len(rows), 1)
        for row in rows:
            self.assertLessEqual(len(row["text"].encode()), 30000)
            self.assertEqual(row["text"], text[row["char_start"]:row["char_end"]])
            self.assertEqual(row["page"], 24)
        self.assertIn("first", "".join(r["text"] for r in rows))
        self.assertIn("second final", "".join(r["text"] for r in rows))
        self.assertNotEqual(rows[0]["id"], hashlib.sha256(f'183:{"a"*64}:23:0'.encode()).hexdigest())

    def test_long_multibyte_token_is_not_truncated_or_split_mid_codepoint(self):
        text = "ğ🙂"*20000
        rows = self.rows(text)
        self.assertEqual("".join(r["text"] for r in rows), text)
        self.assertTrue(all(len(r["text"].encode()) <= 30000 for r in rows))

    def test_voyage_floor_is_provisional_configurable_and_identity_preserving(self):
        with patch.dict("os.environ", {}, clear=True):
            config = EmbeddingConfig("voyage", "voyage-4-large", "voyage-4-lite", "1", 1024)
            identity = config.identity
            self.assertEqual(config.minimum_similarity, 0.30)
            with patch.dict("os.environ", {"MIN_SEMANTIC_SIMILARITY": "0.2"}):
                self.assertEqual(config.minimum_similarity, 0.2)
                self.assertEqual(config.identity, identity)


if __name__ == "__main__":
    unittest.main()
