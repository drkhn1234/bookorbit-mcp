"""Embedding configuration and adapters. Never log input text or provider bodies."""
from dataclasses import dataclass
import hashlib
import json
import math
import os
import random
import time
import urllib.error
import urllib.request

VOYAGE_MODELS = {"voyage-4-large", "voyage-4", "voyage-4-lite"}


@dataclass(frozen=True)
class EmbeddingConfig:
    provider: str
    model: str
    query_model: str
    revision: str
    dimensions: int | None

    @classmethod
    def from_env(cls):
        provider = os.environ.get("EMBED_PROVIDER", "fastembed")
        if provider not in {"fastembed", "voyage"}:
            raise ValueError("EMBED_PROVIDER must be fastembed or voyage")
        model = os.environ.get("EMBED_MODEL", "voyage-4-large" if provider == "voyage" else "BAAI/bge-small-en-v1.5")
        query_model = os.environ.get("EMBED_QUERY_MODEL", "voyage-4-lite" if provider == "voyage" else model)
        dimensions = int(os.environ.get("EMBED_DIMENSIONS", "1024")) if provider == "voyage" else None
        if provider == "voyage":
            if model not in VOYAGE_MODELS or query_model not in VOYAGE_MODELS:
                raise ValueError("Voyage adapter supports only the compatible voyage-4-large/4/4-lite family")
            if dimensions not in {256, 512, 1024, 2048}:
                raise ValueError("Unsupported Voyage embedding dimensions")
        elif query_model != model:
            raise ValueError("FastEmbed requires the same document and query model")
        return cls(provider, model, query_model, os.environ.get("EMBED_REVISION", "1"), dimensions)

    @property
    def identity(self):
        # Preserve deployed local identity byte for byte. Remote query model may
        # change within the explicitly allowlisted shared space without rebuilding.
        identity = f"{self.model}:{self.revision}:chunk-v1-200-40"
        if self.provider != "fastembed":
            identity = f"{self.provider}:{identity}:dim={self.dimensions}:float:l2:document-query-v1"
        return hashlib.sha256(identity.encode()).hexdigest()[:16]

    @property
    def minimum_similarity(self):
        # The BGE cutoff is not transferable to another embedding distribution.
        # Remote candidates remain explicitly labelled uncalibrated in status.
        value = float(os.environ.get("MIN_SEMANTIC_SIMILARITY", "0.65" if self.provider == "fastembed" else "0"))
        if not math.isfinite(value) or not -1 <= value <= 1:
            raise ValueError("MIN_SEMANTIC_SIMILARITY must be finite and between -1 and 1")
        return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Do not forward bearer credentials to redirected hosts.


class VoyageEmbedding:
    def __init__(self, config):
        self.config = config
        if os.environ.get("EMBED_ALLOW_EXTERNAL_CONTENT") != "1":
            raise ValueError("Voyage requires EMBED_ALLOW_EXTERNAL_CONTENT=1: book passages, queries and semantic notes leave this server")
        self.key = os.environ.get("VOYAGE_API_KEY", "").strip()
        if not self.key:
            raise ValueError("VOYAGE_API_KEY is required")
        self.opener = urllib.request.build_opener(NoRedirect())

    def embed(self, texts):
        return self._embed(list(texts), "document")

    def query_embed(self, texts):
        return self._embed(list(texts), "query")

    def _embed(self, texts, input_type):
        import numpy as np
        if not texts:
            return []
        # Bound bytes conservatively rather than silently truncating input.
        if len(texts) > 32 or sum(len(t.encode("utf-8")) for t in texts) > 100_000:
            if len(texts) == 1:
                raise ValueError("Voyage input exceeds conservative input size limit")
            middle = len(texts) // 2
            return self._embed(texts[:middle], input_type) + self._embed(texts[middle:], input_type)
        if any(len(t.encode("utf-8")) > 30_000 for t in texts):
            raise ValueError("Voyage input exceeds conservative 30000-byte limit; split the passage")
        payload = {"input": texts, "model": self.config.query_model if input_type == "query" else self.config.model,
                   "input_type": input_type, "output_dimension": self.config.dimensions,
                   "output_dtype": "float", "truncation": False}
        request = urllib.request.Request("https://api.voyageai.com/v1/embeddings", data=json.dumps(payload).encode(),
                                         headers={"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}, method="POST")
        for attempt in range(4):
            try:
                with self.opener.open(request, timeout=45) as response:
                    result = json.load(response)
                break
            except urllib.error.HTTPError as error:
                # Never propagate provider bodies (which can echo private input).
                if error.code not in {429, 500, 502, 503, 504} or attempt == 3:
                    error.close()
                    raise ValueError(f"Voyage embedding request failed (HTTP {error.code}); check credentials, quota and provider availability") from None
                retry_after = error.headers.get("Retry-After", "")
                delay = min(30, max(0, float(retry_after))) if retry_after.isdigit() else min(16, 2 ** attempt) + random.random()
                error.close()
                time.sleep(delay)
            except (urllib.error.URLError, TimeoutError, OSError):
                if attempt == 3:
                    raise ValueError("Voyage embedding network failure; completed batches retained") from None
                time.sleep(2 ** attempt)
        try:
            rows = sorted(result["data"], key=lambda r: r["index"])
            if [r["index"] for r in rows] != list(range(len(texts))):
                raise ValueError()
            vectors = np.asarray([r["embedding"] for r in rows], dtype=float)
            if vectors.shape != (len(texts), self.config.dimensions) or not np.isfinite(vectors).all():
                raise ValueError()
            norms = np.linalg.norm(vectors, axis=1, keepdims=True)
            if (norms <= 0).any():
                raise ValueError()
            return list(vectors / norms)
        except (KeyError, TypeError, ValueError, OverflowError):
            raise ValueError("Invalid Voyage embedding response; no vectors published") from None
