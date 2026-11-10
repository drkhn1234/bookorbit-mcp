"""Read-only Project Gutenberg source for Shelfarr's custom-provider protocol.

No arbitrary download URLs, credentials or filesystem operations. Catalogue comes
from Gutendex; acquisition resolves only public Project Gutenberg EPUB URLs.
"""
import json
import re
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def fetch_catalog(query):
    url = "https://gutendex.com/books/?" + urllib.parse.urlencode({"search": query})
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError("Catalogue response too large")
    return json.loads(data).get("results", [])[:10]


class Handler(BaseHTTPRequestHandler):
    def reply(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.reply({"status": "ok"}, 200 if self.path == "/health" else 404)

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 64000:
                return self.reply({"error": "Invalid body"}, 400)
            data = json.loads(self.rfile.read(length))
            if self.path == "/search":
                book = data.get("book", {})
                title = str(book.get("title") or "")[:300]
                # Title-first: translated metadata names and author punctuation
                # need not exactly match the Gutenberg catalogue's inverted names.
                candidates = fetch_catalog(title or str(data.get("query", ""))[:300])
                results = []
                for candidate in candidates:
                    # Gutendex's copyright=false is the catalogue's public-domain
                    # indication; jurisdiction/source rights remain user-specific.
                    if candidate.get("copyright") is not False:
                        continue
                    languages = candidate.get("languages", [])
                    requested = data.get("request", {}).get("language")
                    if requested and requested not in languages:
                        continue
                    identifier = candidate["id"]
                    results.append({
                        "id": str(identifier), "title": candidate["title"],
                        "author": ", ".join(a["name"] for a in candidate.get("authors", [])),
                        "format": "epub", "language": languages[0] if languages else "en",
                        "download_type": "direct", "availability": "available",
                        "info_url": f"https://www.gutenberg.org/ebooks/{identifier}",
                    })
                self.reply({"results": results})
            elif self.path == "/acquire":
                identifier = str(data.get("provider_result_id", ""))
                if not re.fullmatch(r"[1-9][0-9]{0,7}", identifier):
                    return self.reply({"error": "Invalid Gutenberg identifier"}, 400)
                self.reply({"download_type": "direct", "direct_url":
                    f"https://www.gutenberg.org/ebooks/{identifier}.epub3.images"})
            else:
                self.reply({"error": "Not found"}, 404)
        except (ValueError, OSError, KeyError):
            self.reply({"error": "Public-domain catalogue unavailable; retry later"}, 502)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
