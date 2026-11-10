"""Bounded metadata/container check before an external acquisition is published."""
import base64
import io
import re
import unicodedata
import xml.etree.ElementTree as ET
import zipfile


def words(value):
    value = unicodedata.normalize("NFKD", value).casefold()
    return set(re.findall(r"[^\W_]+", value, re.UNICODE))


def inspect_artifact(data):
    raw = base64.b64decode(data["data"], validate=True)
    if len(raw) > 128 * 1024 * 1024:
        raise ValueError("Artifact too large")
    if raw.startswith(b"%PDF-"):
        import fitz
        with fitz.open(stream=raw, filetype="pdf") as doc:
            if doc.is_encrypted:
                raise ValueError("Encrypted PDF requires review")
            metadata = doc.metadata or {}
            title = metadata.get("title", "")
            authors = [metadata.get("author", "")]
    else:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            def xml(path):
                info = archive.getinfo(path)
                if info.file_size > 128000:
                    raise ValueError("EPUB metadata exceeds limit")
                value = archive.read(info)
                if b"<!DOCTYPE" in value or b"<!ENTITY" in value:
                    raise ValueError("EPUB metadata DTD is not permitted")
                return ET.fromstring(value)
            if archive.getinfo("mimetype").file_size != 20 or archive.read("mimetype") != b"application/epub+zip":
                raise ValueError("Not an EPUB container")
            container = xml("META-INF/container.xml")
            rootfile = container.find(".//{*}rootfile")
            if rootfile is None:
                raise ValueError("Missing EPUB package")
            package = rootfile.attrib.get("full-path", "")
            if package.startswith("/") or ".." in package.split("/"):
                raise ValueError("Unsafe EPUB package path")
            metadata = xml(package)
            title = " ".join(metadata.findtext(".//{*}title", "").split())[:2000]
            authors = [" ".join(n.itertext())[:1000] for n in metadata.findall(".//{*}creator")[:20]]
    expected = words(data["title"])
    found = words(title)
    # Metadata is evidence, not proof of edition identity. Missing metadata is
    # explicitly unverified; an actual conflicting title/author is never accepted.
    title_matches = bool(expected and found and len(expected & found) / len(expected) >= 0.6)
    author = data.get("author", "")
    surname = author.split(",")[0] if "," in author else author.split()[-1] if author.split() else ""
    author_matches = bool(words(surname) & words(" ".join(authors)))
    status = "verified" if title_matches and author_matches else "unverified"
    if (found and not title_matches) or (any(authors) and not author_matches):
        status = "mismatch"
    return {"title": title, "authors": authors, "metadataMatch": status,
            "editionVerified": False}
