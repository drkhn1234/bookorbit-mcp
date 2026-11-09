"""Provider contract tests: synthetic input only; no external API calls."""
import hashlib
import io
import json
import os
import unittest
from unittest.mock import patch
import urllib.error
from embeddings import EmbeddingConfig, VoyageEmbedding, NoRedirect


class ProviderTests(unittest.TestCase):
    def config(self, **values):
        with patch.dict(os.environ, values, clear=True):
            return EmbeddingConfig.from_env()

    def provider(self):
        with patch.dict(os.environ, {"VOYAGE_API_KEY": "synthetic-secret", "EMBED_ALLOW_EXTERNAL_CONTENT": "1"}):
            return VoyageEmbedding(self.config(EMBED_PROVIDER="voyage"))

    def response(self, indices=(0,), dimension=1024):
        return io.BytesIO(json.dumps({"data": [{"index": i, "embedding": [3, 4] + [0] * (dimension-2)} for i in indices]}).encode())

    def test_preserve_local_identity_and_separate_configurations(self):
        local = self.config()
        self.assertEqual(local.identity, hashlib.sha256(b"BAAI/bge-small-en-v1.5:1:chunk-v1-200-40").hexdigest()[:16])
        remote = self.config(EMBED_PROVIDER="voyage")
        self.assertNotEqual(local.identity, remote.identity)
        self.assertEqual(remote.identity, self.config(EMBED_PROVIDER="voyage", EMBED_QUERY_MODEL="voyage-4-large").identity)
        for change in ({"EMBED_DIMENSIONS": "2048"}, {"EMBED_MODEL": "voyage-4"}, {"EMBED_REVISION": "2"}):
            self.assertNotEqual(remote.identity, self.config(EMBED_PROVIDER="voyage", **change).identity)
        with self.assertRaises(ValueError): self.config(EMBED_PROVIDER="voyage", EMBED_QUERY_MODEL="voyage-context-4")
        with self.assertRaises(ValueError): self.config(EMBED_PROVIDER="voyage", EMBED_DIMENSIONS="384")
        with self.assertRaises(ValueError): self.config(EMBED_QUERY_MODEL="other")

    def test_external_consent_and_key_required(self):
        config = self.config(EMBED_PROVIDER="voyage")
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "ALLOW_EXTERNAL"): VoyageEmbedding(config)
        with patch.dict(os.environ, {"EMBED_ALLOW_EXTERNAL_CONTENT": "1"}, clear=True):
            with self.assertRaisesRegex(ValueError, "API_KEY"): VoyageEmbedding(config)

    def test_query_document_modes_order_dimensions_and_normalization(self):
        provider = self.provider()
        with patch.object(provider.opener, "open", side_effect=[self.response((1,0)), self.response()]) as call:
            vectors = provider.embed(["synthetic A", "synthetic B"])
            provider.query_embed(["Türkçe fizik sorusu"])
        self.assertEqual(len(vectors), 2)
        self.assertAlmostEqual(float(vectors[0][0]), .6)
        self.assertAlmostEqual(float(vectors[0][1]), .8)
        requests = [json.loads(c.args[0].data) for c in call.call_args_list]
        self.assertEqual([r["input_type"] for r in requests], ["document", "query"])
        self.assertEqual([r["model"] for r in requests], ["voyage-4-large", "voyage-4-lite"])
        self.assertEqual(requests[0]["output_dimension"], 1024)
        self.assertFalse(requests[0]["truncation"])
        self.assertEqual(call.call_args.args[0].full_url, "https://api.voyageai.com/v1/embeddings")
        self.assertIsNone(NoRedirect().redirect_request(None,None,302,"",{},"https://other.example"))

    def test_invalid_vectors_fail_closed(self):
        for payload in (self.response(dimension=3).getvalue(), self.response((0,0)).getvalue(), b'{"data": []}',
                        json.dumps({"data": [{"index": 0, "embedding": [float("nan")] * 1024}]}).encode(),
                        json.dumps({"data": [{"index": 0, "embedding": [0] * 1024}]}).encode()):
            provider = self.provider()
            with patch.object(provider.opener, "open", return_value=io.BytesIO(payload)):
                with self.assertRaisesRegex(ValueError, "Invalid Voyage"): provider.embed(["PRIVATE"])

    def test_retry_rate_limit_but_do_not_retry_or_echo_credentials_errors(self):
        provider = self.provider()
        error = urllib.error.HTTPError("https://api.voyageai.com", 429, "PRIVATE", {"Retry-After":"0"}, io.BytesIO(b"PRIVATE"))
        with patch.object(provider.opener, "open", side_effect=[error,self.response()]) as call, patch("embeddings.time.sleep"):
            self.assertEqual(len(provider.embed(["PRIVATE"])), 1)
            self.assertEqual(call.call_count, 2)
        error = urllib.error.HTTPError("https://api.voyageai.com", 401, "synthetic-secret PRIVATE", {}, io.BytesIO(b"PRIVATE"))
        with patch.object(provider.opener, "open", side_effect=error) as call:
            with self.assertRaises(ValueError) as caught: provider.embed(["PRIVATE"])
            self.assertEqual(call.call_count, 1)
            self.assertNotIn("PRIVATE", str(caught.exception))
            self.assertNotIn("synthetic-secret", str(caught.exception))

    def test_rate_limit_without_retry_after_waits_for_minute_window(self):
        provider = self.provider()
        errors = [urllib.error.HTTPError("https://api.voyageai.com", 429, "PRIVATE", {}, io.BytesIO()) for _ in range(2)]
        with patch.object(provider.opener, "open", side_effect=[*errors,self.response()]), patch("embeddings.time.sleep") as sleep:
            self.assertEqual(len(provider.query_embed(["synthetic"])), 1)
            self.assertEqual([c.args[0] for c in sleep.call_args_list], [30,30])

    def test_bounds_do_not_silently_truncate(self):
        provider = self.provider()
        with patch.object(provider.opener, "open") as call:
            with self.assertRaises(ValueError): provider.embed(["ü" * 16000])
            call.assert_not_called()

    def test_large_batches_split_without_dropping_text(self):
        provider = self.provider()
        with patch.object(provider.opener, "open", side_effect=[self.response(tuple(range(64))), self.response(tuple(range(65)))]) as call:
            result = provider.embed(["synthetic"] * 129)
        self.assertEqual(len(result), 129)
        self.assertEqual(call.call_count, 2)


class RemoteWorkerTests(unittest.TestCase):
    def test_remote_index_resume_prefilter_citations_and_lexical_without_api(self):
        import importlib.util
        from pathlib import Path
        import tempfile
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "KNOWLEDGE_DIR": directory, "EMBED_PROVIDER": "voyage",
            "VOYAGE_API_KEY": "synthetic-secret", "EMBED_ALLOW_EXTERNAL_CONTENT": "1",
        }, clear=True):
            spec = importlib.util.spec_from_file_location("remote_worker_test", Path(__file__).with_name("worker.py"))
            w = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(w)
            provider = w.model()
            calls = []
            def response(request, **kwargs):
                payload = json.loads(request.data)
                calls.append(payload)
                # Deterministic synthetic vectors test plumbing, NOT model quality.
                return io.BytesIO(json.dumps({"data": [{"index": i, "embedding": [1, 0] + [0]*1022} for i,_ in enumerate(payload["input"])]}).encode())
            data = {"bookId": 1, "fingerprint": "a"*64, "sections": [
                {"index": i, "label": f"Synthetic section {i}", "page": i+1, "text": "Electric fields describe force per unit charge."} for i in range(129)]}
            try:
                with patch.object(provider.opener, "open", side_effect=[self._response(128), ValueError("simulated interruption")]):
                    with self.assertRaisesRegex(ValueError, "interruption"): w.index(data)
                self.assertEqual(w.conn.execute("SELECT count(*) FROM staged").fetchone()[0], 128)
                self.assertEqual(w.conn.execute("SELECT count(*) FROM sources").fetchone()[0], 0)
                with patch.object(provider.opener, "open", side_effect=response):
                    w.index(data)
                    self.assertEqual(len(calls[0]["input"]), 1)
                    w.index({"bookId": 2, "fingerprint": "b"*64, "sections": [{"index":0,"label":"Private","text":"PRIVATE electric fields"}]})
                    result = w.search({"query":"Elektrik alanı nedir?", "mode":"semantic", "allowed":[{"bookId":1,"fingerprint":"a"*64}]})
                    self.assertTrue(result)
                    self.assertTrue(all(r["book_id"] == 1 for r in result))
                    self.assertEqual(calls[-1]["input_type"], "query")
                    self.assertEqual(calls[-1]["model"], "voyage-4-lite")
                    notes = {"namespace":"1"*64, "query":"electric fields", "mode":"semantic",
                             "items":[{"id":7,"version":"own-current","text":"Own synthetic physics note"}]}
                    self.assertEqual(w.search_notes(notes)[0]["id"], 7)
                    self.assertEqual(calls[-1]["input_type"], "document")
                    self.assertEqual(calls[-1]["model"], "voyage-4-large")
                    # Cached vectors cannot resurrect removed notes.
                    self.assertEqual(w.search_notes({**notes,"items":[]}), [])
                    citation = w.passage({"bookId":1,"fingerprint":"a"*64,"passageId":result[0]["id"]})
                    self.assertEqual(citation["passage"]["page"], result[0]["page"])
                    self.assertEqual(w.search({"query":"fields","allowed":[{"bookId":1,"fingerprint":"c"*64}]}), [])
                with patch.object(provider.opener, "open", side_effect=AssertionError("Lexical search must not call provider")):
                    self.assertTrue(w.search({"query":"electric","mode":"lexical","allowed":[{"bookId":1,"fingerprint":"a"*64}]}))
                # Unrelated nearest neighbors must not become evidence simply
                # because they are the only authorized semantic candidates.
                weak = io.BytesIO(json.dumps({"data": [{"index":0,
                    "embedding":[0.2, (1-0.2**2)**0.5]+[0]*1022}]}).encode())
                with patch.object(provider.opener, "open", return_value=weak):
                    self.assertEqual(w.search({"query":"unrelated topic","mode":"semantic",
                        "allowed":[{"bookId":1,"fingerprint":"a"*64}]}), [])
            finally:
                w.conn.close()

    def _response(self, count):
        return io.BytesIO(json.dumps({"data": [{"index": i, "embedding": [1]+[0]*1023} for i in range(count)]}).encode())


if __name__ == "__main__": unittest.main()
