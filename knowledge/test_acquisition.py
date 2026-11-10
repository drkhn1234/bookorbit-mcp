import base64
import io
import unittest
import zipfile
from acquisition import inspect_artifact


class AcquisitionMetadataTests(unittest.TestCase):
    def fixture(self, title="The Tale of Peter Rabbit"):
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as archive:
            archive.writestr("mimetype", "application/epub+zip")
            archive.writestr("META-INF/container.xml", '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
            archive.writestr("book.opf", f'<package><metadata><title>{title}</title><creator>Potter, Beatrix</creator></metadata></package>')
        return base64.b64encode(out.getvalue()).decode()

    def test_correct_and_mislabeled_content(self):
        args = {"data": self.fixture(), "title": "The Tale of Peter Rabbit", "author": "Beatrix Potter"}
        self.assertEqual(inspect_artifact(args)["metadataMatch"], "verified")
        self.assertFalse(inspect_artifact(args)["editionVerified"])
        self.assertEqual(inspect_artifact({**args, "data": self.fixture("A Completely Different Book")})["metadataMatch"], "mismatch")

    def test_malformed_container_is_rejected(self):
        with self.assertRaises(Exception):
            inspect_artifact({"data": base64.b64encode(b"PKarbitraryzip").decode(), "title": "Book", "author": "Writer"})
