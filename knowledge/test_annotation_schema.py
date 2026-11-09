"""Local LanceDB schema contract and authorization-prefilter tests; synthetic only."""
from datetime import datetime, timezone
import tempfile
import unittest

import lancedb
import pyarrow as pa

from annotation_schema import (UNITS_TABLE, LINKS_TABLE, authorized_filter,
                               ensure_tables, unit_id, unit_schema)


class AnnotationSchemaTests(unittest.TestCase):
    def test_native_atomic_units_have_stable_distinct_scoped_ids(self):
        a = unit_id("a"*64, 1, "highlight")
        self.assertEqual(a, unit_id("a"*64, 1, "highlight"))
        self.assertNotEqual(a, unit_id("a"*64, 1, "note"))
        self.assertNotEqual(a, unit_id("b"*64, 1, "highlight"))
        for args in [("a' OR true", 1, "note"), ("a"*64, -1, "note"), ("a"*64, 1, "combined")]:
            with self.assertRaises(ValueError): unit_id(*args)

    def test_tables_are_explicit_and_refuse_model_dimension_or_schema_drift(self):
        with tempfile.TemporaryDirectory() as path:
            db = lancedb.connect(path)
            tables = ensure_tables(db, 2, "a"*16)
            self.assertEqual(set(tables), {UNITS_TABLE, LINKS_TABLE})
            self.assertEqual(tables[UNITS_TABLE].schema.field("vector").type, pa.list_(pa.float32(), 2))
            self.assertEqual(ensure_tables(db, 2, "a"*16)[UNITS_TABLE].count_rows(), 0)
            with self.assertRaises(ValueError): ensure_tables(db, 3, "a"*16)
            with self.assertRaises(ValueError): ensure_tables(db, 2, "b"*16)
            self.assertEqual(db.open_table(UNITS_TABLE).count_rows(), 0)

    def test_vector_prefilter_isolates_owner_live_version_and_book_before_top_k(self):
        with tempfile.TemporaryDirectory() as path:
            db = lancedb.connect(path)
            table = ensure_tables(db, 2, "a"*16)[UNITS_TABLE]
            def row(owner, ann, book, version, vector):
                values = {f.name: None for f in unit_schema(2, "a"*16)}
                values.update(id=unit_id(owner,ann,"highlight"),owner_scope=owner,annotation_id=ann,
                              kind="highlight",book_id=book,library_id=1,annotation_version=version,
                              source_version="c"*64,text="synthetic atomic selection",text_sha256="d"*64,
                              embedding_text_sha256="d"*64,embedding_input_mode="document",
                              embedding_provenance="direct",vector=vector,indexed_at=datetime.now(timezone.utc))
                return values
            wanted = row("a"*64, 1, 1, "e"*64, [0.8,0.2])
            table.add([wanted,row("b"*64,1,1,"e"*64,[1.,0.]),
                       row("a"*64,2,2,"e"*64,[1.,0.]),row("a"*64,3,1,"f"*64,[1.,0.])])
            where = authorized_filter("a"*64,[(1,"c"*64)],[(wanted["id"],"e"*64)])
            hits = table.search([1.,0.]).where(where,prefilter=True).limit(1).to_list()
            self.assertEqual([r["id"] for r in hits],[wanted["id"]])
            for books,units in [([],[(wanted["id"],"e"*64)]), ([(1,"c"*64)],[]),
                                ([(1,"c"*64)],[(wanted["id"],"f"*64)])]:
                self.assertEqual(table.search([1.,0.]).where(authorized_filter("a"*64,books,units),prefilter=True).limit(1).to_list(),[])

    def test_location_preserved_and_many_highlights_can_reference_one_passage(self):
        with tempfile.TemporaryDirectory() as path:
            links = ensure_tables(lancedb.connect(path),2,"a"*16)[LINKS_TABLE]
            records=[]
            for owner in ["a"*64,"b"*64]:
                records.append(dict(id=owner,owner_scope=owner,unit_id=unit_id(owner,1,"highlight"),
                                    annotation_version="d"*64,book_id=1,source_version="c"*64,
                                    passage_id="e"*64,passage_index_identity="f"*16,
                                    match_method="exact_text",section=0,char_start=12,char_end=99))
            links.add(records)
            self.assertEqual(links.count_rows(),2)
            self.assertEqual(links.search().where("owner_scope='"+"a"*64+"'").to_list()[0]["char_start"],12)


if __name__ == "__main__":
    unittest.main()
