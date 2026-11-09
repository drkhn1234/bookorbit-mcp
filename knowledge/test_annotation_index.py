"""Actual LanceDB atomic lifecycle tests. Synthetic two-dimensional vectors only."""
import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest
import numpy as np
import lancedb
from annotation_index import AnnotationIndex, digest
from annotation_schema import unit_id
from embeddings import EmbeddingConfig


class AtomicIndexTests(unittest.TestCase):
    def setUp(self):
        self.scratch=tempfile.TemporaryDirectory();self.root=Path(self.scratch.name)
        self.conn=sqlite3.connect(self.root/'sources.sqlite3')
        self.conn.execute('CREATE VIRTUAL TABLE passages USING fts5(id UNINDEXED,book_id UNINDEXED,fingerprint UNINDEXED,text)')
        self.legacy=sqlite3.connect(self.root/'legacy.sqlite3')
        self.legacy.execute('CREATE TABLE vectors(namespace TEXT,note_id INTEGER,version TEXT,text_hash TEXT,vector TEXT,used REAL)')
        self.books=lancedb.connect(str(self.root/'books'))
        self.calls=0
        outer=self
        class Engine:
            def embed(self,texts):
                outer.calls+=len(texts)
                return [np.array([0.,1.]) if 'bread' in t else np.array([0.8,0.2]) for t in texts]
        self.engine=Engine()
        self.config=EmbeddingConfig('voyage','voyage-4-large','voyage-4-lite','1',2)
        self.index=self.reopen()

    def reopen(self):
        return AnnotationIndex(self.root,self.config,lambda:self.engine,lambda q:np.array([1.,0.]),
                               lambda:self.books.open_table('passages') if 'passages' in self.books.list_tables().tables else None,
                               self.conn,self.legacy)

    def tearDown(self):
        self.conn.close();self.legacy.close();self.scratch.cleanup()

    def row(self,annotation=1,kind='highlight',**fields):
        return {'annotationId':annotation,'bookId':1,'libraryId':1,'kind':kind,'text':'Synthetic neurons communicate using chemical signals.',
                'version':'a'*64,'sourceVersion':'b'*64,**fields}

    def sync(self,items,owner='1'*64):
        return self.index.sync({'namespace':owner,'items':items})

    def search(self,items,owner='1'*64,limit=10):
        return self.index.search({'namespace':owner,'items':[{'id':unit_id(owner,r['annotationId'],r['kind']),
            'bookId':r['bookId'],'sourceVersion':r['sourceVersion'],'version':r['version']} for r in items],
            'query':'neural communication','mode':'semantic','limit':limit})

    def test_atomic_units_restart_edit_delete_and_no_cross_account_cache_reuse(self):
        a=self.row();n=self.row(kind='note',text='My personal scientific connection.')
        self.sync([a,n]);self.assertEqual(self.calls,2)
        hits=self.search([a,n]);self.assertEqual({h['kind'] for h in hits},{'highlight','note'})
        self.index=self.reopen();self.sync([a,n]);self.assertEqual(self.calls,2)
        self.sync([self.row(version='c'*64,page=42,cfi='native-reader-cfi'),n]);self.assertEqual(self.calls,2)
        self.assertEqual(self.search([a]),[])
        edited=self.row(version='d'*64,text='A bread recipe.')
        self.sync([edited]);self.assertEqual(self.calls,3)
        self.sync([a],owner='2'*64);self.assertEqual(self.calls,4)
        # Partial snapshots cannot delete unseen components; complete owner purge
        # must not remove another account's identical native annotation ID.
        self.index.finish({'namespace':'1'*64,'currentIds':[],'snapshotComplete':False,'scanned':0,'total':2})
        self.assertEqual(self.index.table().count_rows(),3)
        self.index.finish({'namespace':'1'*64,'currentIds':[],'snapshotComplete':True,'scanned':0,'total':0})
        self.assertEqual(self.index.table().count_rows(),1)
        self.assertEqual(len(self.search([a],owner='2'*64)),1)

    def test_permission_and_live_version_filters_precede_top_k(self):
        a=self.row();private=self.row(annotation=2,bookId=2)
        self.sync([a,private]);self.sync([a],owner='2'*64)
        hit=self.search([a],limit=1)
        self.assertEqual(hit[0]['id'],1)
        self.assertEqual(self.search([]),[])
        self.assertEqual(self.search([self.row(sourceVersion='f'*64)]),[])
        self.assertEqual(self.search([self.row(version='f'*64)]),[])

    def test_exact_passage_reuse_and_verified_link_without_embedding(self):
        row=self.row();text=row['text'];pid='e'*64
        self.books.create_table('passages',data=[{'id':pid,'book_id':1,'fingerprint':'b'*64,'sha256':digest(text),
            'section':2,'char_start':12,'text':text,'vector':[1.,0.]}])
        self.conn.execute('INSERT INTO passages VALUES(?,?,?,?)',(pid,1,'b'*64,text));self.conn.commit()
        result=self.sync([row]);self.assertEqual(self.calls,0)
        self.assertEqual(result['reused'],1)
        hit=self.search([row])[0]
        self.assertEqual(hit['embeddingProvenance'],'exact_passage_reuse')
        self.assertEqual(hit['sourceLinks'][0]['charStart'],12)
        # A selected substring gets its own vector, but may link to source context.
        selected=self.row(annotation=3,text='neurons communicate using chemical signals.')
        self.sync([selected]);self.assertEqual(self.calls,1)
        self.assertEqual(self.search([selected])[0]['sourceLinks'][0]['method'],'exact_text')

    def test_oversized_component_is_reported_not_truncated(self):
        row=self.row();self.sync([row])
        result=self.sync([self.row(version='f'*64,text='ğ'*15001)])
        self.assertEqual(self.calls,1)
        self.assertEqual(len(result['errors']),1)
        self.assertEqual(self.index.table().count_rows(),0)
        self.assertEqual(self.search([row]),[])

    def test_more_than_500_units_use_bounded_prefilter_partitions(self):
        items=[self.row(annotation=i) for i in range(1,611)]
        for start in range(0,len(items),100):self.sync(items[start:start+100])
        last=items[-1]
        # A late unit can be retrieved even with many earlier closer candidates
        # on disk; live authorization is inside each search partition.
        self.assertEqual(self.search([last],limit=1)[0]['id'],610)
        self.assertEqual(len(self.search(items,limit=20)),20)

    def test_interrupted_batches_resume_and_only_exact_legacy_inputs_are_reused(self):
        items=[self.row(annotation=i) for i in range(1,35)]
        original=self.engine.embed;calls=0
        def interrupted(texts):
            nonlocal calls
            calls+=1
            if calls>1:raise ValueError('simulated failure')
            return original(texts)
        self.engine.embed=interrupted
        with self.assertRaisesRegex(ValueError,'simulated'):self.sync(items)
        self.assertEqual(self.index.table().count_rows(),32)
        self.engine.embed=original;self.index=self.reopen();self.sync(items)
        self.assertEqual(self.calls,34)
        row=self.row(annotation=100)
        self.legacy.execute('INSERT INTO vectors VALUES(?,?,?,?,?,?)',('1'*64,100,'a'*64,digest(row['text']+'\n'),'[1,0]',0));self.legacy.commit()
        self.sync([row]);self.assertEqual(self.calls,35) # combined legacy bytes differ
        exact=self.row(annotation=101)
        self.legacy.execute('INSERT INTO vectors VALUES(?,?,?,?,?,?)',('1'*64,101,'a'*64,digest(exact['text']),'[1,0]',0));self.legacy.commit()
        self.sync([exact]);self.assertEqual(self.calls,35)


if __name__=='__main__':unittest.main()
