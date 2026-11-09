"""Private atomic annotation index. Live snapshots authorize every search.

BookOrbit records are authoritative. Only this module writes the derived annotation
LanceDB; no annotation text is written to SQLite or ordinary application logs.
"""
from datetime import datetime, timezone, timedelta
import hashlib
import json
import re
import time

import numpy as np
import pyarrow as pa
from annotation_schema import (UNITS_TABLE, LINKS_TABLE, _hex, _positive,
                               authorized_filter, ensure_tables, unit_id)


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


class AnnotationIndex:
    def __init__(self, root, config, model, query_vector, passage_table, source_conn, legacy_conn):
        import lancedb
        self.config, self.model, self.query_vector = config, model, query_vector
        self.passage_table, self.conn, self.legacy = passage_table, source_conn, legacy_conn
        self.db = lancedb.connect(str(root / 'annotations.lancedb'))
        if config.dimensions:
            self.dimensions = config.dimensions
        else:
            from fastembed import TextEmbedding
            self.dimensions = TextEmbedding.get_embedding_size(config.model)
        self.tables = ensure_tables(self.db, self.dimensions, config.identity)
        self.validation_tokenizer = None
        with self.conn:
            self.conn.execute('CREATE TABLE IF NOT EXISTS annotation_sync_jobs(owner TEXT PRIMARY KEY, state TEXT, scanned INTEGER, total INTEGER, updated REAL, error TEXT)')
            self.conn.execute('CREATE TABLE IF NOT EXISTS annotation_maintenance(id INTEGER PRIMARY KEY, updated REAL)')

    def table(self, name=UNITS_TABLE):
        return self.db.open_table(name)

    def validate(self, owner, row):
        _hex(owner, 64)
        _positive(row['annotationId']); _positive(row['bookId']); _positive(row['libraryId'])
        _hex(row['version'],64); _hex(row['sourceVersion'],64)
        if row.get('kind') not in {'highlight','note'} or not isinstance(row.get('text'),str):
            raise ValueError('Invalid atomic annotation component')
        for k in ('page','chapterIndex','fileId'):
            value=row.get(k)
            if value is not None and (type(value) is not int or value<0):
                raise ValueError('Invalid annotation location')
        for k in ('cfi','chapter','origin','positionStatus','createdAt'):
            if row.get(k) is not None and not isinstance(row[k],str):
                raise ValueError('Invalid annotation location')
        return unit_id(owner,row['annotationId'],row['kind'])

    def atomic_error(self, text):
        if len(text.encode()) > 30_000:
            return 'Atomic component exceeds 30000 UTF-8 bytes; not split or truncated'
        if self.config.provider=='fastembed':
            # Inspect full tokenizer output without changing the inference tokenizer.
            from tokenizers import Tokenizer
            if self.validation_tokenizer is None:
                native=self.model().model.tokenizer
                tokenizer=Tokenizer.from_str(native.to_str())
                self.token_limit=tokenizer.truncation['max_length'] if tokenizer.truncation else None
                tokenizer.no_truncation(); tokenizer.no_padding()
                self.validation_tokenizer=tokenizer
            if self.token_limit and len(self.validation_tokenizer.encode(text).ids)>self.token_limit:
                return 'Atomic component exceeds local model token limit; not split or truncated'
        return None

    def vector(self, value):
        v=np.asarray(value,dtype=float)
        if v.shape!=(self.dimensions,) or not np.all(np.isfinite(v)) or np.linalg.norm(v)==0:
            raise ValueError('Invalid atomic annotation embedding')
        return (v/np.linalg.norm(v)).astype('float32').tolist()

    def exact_passage(self,row):
        table=self.passage_table()
        if table is None:return None
        where=f"book_id={row['bookId']} AND fingerprint='{row['sourceVersion']}' AND sha256='{digest(row['text'])}'"
        hits=table.search().where(where).limit(2).to_list()
        return next((h for h in hits if h['text']==row['text']),None)

    def links(self, owner, row, uid):
        if row['kind']!='highlight' or len(row['text'].strip())<20:return []
        # Candidate lookup is bounded; a partial/ambiguous mapping is not certified.
        words=re.findall(r'\w+',row['text'],re.UNICODE)
        if not words:return []
        expr=' AND '.join('"'+w+'"' for w in words[:4])
        candidates=self.conn.execute('SELECT id,text FROM passages WHERE passages MATCH ? AND book_id=? AND fingerprint=? LIMIT 21',
                                     (expr,row['bookId'],row['sourceVersion'])).fetchall()
        if len(candidates)>20:return []
        ids=[pid for pid,text in candidates if row['text'] in text]
        table=self.passage_table()
        if not ids or table is None:return []
        found=table.search().where(f"book_id={row['bookId']} AND fingerprint='{row['sourceVersion']}' AND id IN ("+','.join("'"+_hex(i,64)+"'" for i in ids)+')').limit(20).to_list()
        anchors={};hits=[]
        for hit in found:
            start=0
            while (start:=hit['text'].find(row['text'],start))>=0:
                lo=hit['char_start']+start
                anchors[(hit['section'],lo,lo+len(row['text']))]=True
                hits.append((hit,lo,lo+len(row['text'])))
                start+=1
        if len(anchors)!=1:return []
        return [dict(id=digest(json.dumps([owner,uid,row['version'],row['sourceVersion'],h['id']])),owner_scope=owner,
                     unit_id=uid,annotation_version=row['version'],book_id=row['bookId'],source_version=row['sourceVersion'],
                     passage_id=h['id'],passage_index_identity=self.config.identity,match_method='exact_text',section=h['section'],
                     char_start=lo,char_end=hi) for h,lo,hi in hits]

    def sync(self,data):
        owner=_hex(data['namespace'],64)
        items=data['items']
        if len(items)>100:raise ValueError('Atomic sync batch exceeds 100 components')
        prepared=[];errors=[];reused=0
        table=self.table()
        for row in items:
            uid=self.validate(owner,row)
            if not row['text'].strip():continue
            error=self.atomic_error(row['text'])
            if error:
                errors.append({'annotationId':row['annotationId'],'kind':row['kind'],'error':error})
                table.delete(f"owner_scope='{owner}' AND id='{uid}'")
                self.table(LINKS_TABLE).delete(f"owner_scope='{owner}' AND unit_id='{uid}'")
                continue
            sha=digest(row['text'])
            cached=table.search().where(f"owner_scope='{owner}' AND id='{uid}'").limit(1).to_list()
            if cached and all(cached[0][k]==v for k,v in {'annotation_version':row['version'],'source_version':row['sourceVersion'],
                    'library_id':row['libraryId'],'text_sha256':sha}.items()):
                reused+=1;continue
            value={f.name:None for f in table.schema}
            value.update(id=uid,owner_scope=owner,annotation_id=row['annotationId'],kind=row['kind'],book_id=row['bookId'],
                         library_id=row['libraryId'],annotation_version=row['version'],source_version=row['sourceVersion'],
                         text=row['text'],text_sha256=sha,embedding_text_sha256=sha,embedding_input_mode='document',
                         embedding_provenance='direct',indexed_at=datetime.now(timezone.utc))
            for k,v in {'reader_page':'page','reader_cfi':'cfi','reader_chapter':'chapter','reader_chapter_index':'chapterIndex',
                        'reader_file_id':'fileId','reader_origin':'origin','reader_position_status':'positionStatus','source_created_at':'createdAt'}.items():
                value[k]=row.get(v)
            if cached and cached[0]['embedding_text_sha256']==sha:
                value['vector']=cached[0]['vector'];value['embedding_provenance']=cached[0]['embedding_provenance']
                value['reused_passage_id']=cached[0]['reused_passage_id'];reused+=1
            else:
                exact=self.exact_passage(row) if row['kind']=='highlight' else None
                if exact:
                    value['vector']=self.vector(exact['vector']);value['embedding_provenance']='exact_passage_reuse'
                    value['reused_passage_id']=exact['id'];reused+=1
                else:
                    # Legacy input was combined and truncated. A matching native
                    # ID/version is insufficient: require actual exact input hash.
                    legacy=self.legacy.execute('SELECT vector FROM vectors WHERE namespace=? AND note_id=? AND text_hash=?',
                                               (owner,row['annotationId'],sha)).fetchone()
                    if legacy:
                        value['vector']=self.vector(json.loads(legacy[0]));reused+=1
            prepared.append((row,value))
        # Publish each successfully completed provider batch. Interrupted syncs
        # retry only absent/changed inputs, including after a process restart.
        pending=[(r,v) for r,v in prepared if 'vector' not in v or v['vector'] is None]
        for start in range(0,len(pending),32):
            batch=pending[start:start+32]
            values=list(self.model().embed([r['text'] for r,v in batch]))
            if len(values)!=len(batch):raise ValueError('Atomic embedding count mismatch')
            for (r,v),vector in zip(batch,values,strict=True):v['vector']=self.vector(vector)
            self.publish(owner,batch)
        ready=[(r,v) for r,v in prepared if all(v is not pv for pr,pv in pending)]
        if ready:self.publish(owner,ready)
        with self.conn:
            self.conn.execute('INSERT OR REPLACE INTO annotation_sync_jobs VALUES(?,?,?,?,?,NULL)',
                              (owner,'syncing',data.get('scanned',0),data.get('total',0),time.time()))
        return {'indexed':len(prepared),'reused':reused,'errors':errors}

    def publish(self,owner,prepared):
        if not prepared:return
        table=self.table()
        records=[v for r,v in prepared]
        table.merge_insert('id').when_matched_update_all().when_not_matched_insert_all().execute(pa.Table.from_pylist(records,schema=table.schema))
        links=self.table(LINKS_TABLE)
        for row,value in prepared:
            links.delete(f"owner_scope='{owner}' AND unit_id='{value['id']}'")
            records=self.links(owner,row,value['id'])
            if records:links.add(pa.Table.from_pylist(records,schema=links.schema))

    def finish(self,data):
        owner=_hex(data['namespace'],64)
        ids=[_hex(i,64) for i in data['currentIds']]
        if data.get('snapshotComplete'):
            # Read only this owner, then delete obsolete IDs in small predicates.
            existing=self.table().search().where(f"owner_scope='{owner}'").select(['id']).limit(100001).to_list()
            if len(existing)>100000:raise ValueError('Annotation index exceeds 100000 unit maintenance limit')
            live_ids=set(ids)
            absent=[r['id'] for r in existing if r['id'] not in live_ids]
            for start in range(0,len(absent),200):
                predicate=f"owner_scope='{owner}' AND "+'id IN ('+','.join("'"+i+"'" for i in absent[start:start+200])+')'
                self.table().delete(predicate)
                self.table(LINKS_TABLE).delete(predicate.replace('id IN','unit_id IN'))
        with self.conn:
            self.conn.execute('INSERT OR REPLACE INTO annotation_sync_jobs VALUES(?,?,?,?,?,NULL)',
                              (owner,'complete' if data.get('snapshotComplete') else 'partial',data['scanned'],data['total'],time.time()))
        self.maintain()
        return {'state':'complete' if data.get('snapshotComplete') else 'partial'}

    def maintain(self):
        # Current text follows source snapshots. Inactive account rows expire
        # after30days. Daily maintenance uses a24h old-version cleanup cutoff;
        # this is not a wall-clock erasure guarantee while the service is offline.
        # Current queries never read historical versions.
        now=time.time()
        with self.conn:
            stale=[r[0] for r in self.conn.execute('SELECT owner FROM annotation_sync_jobs WHERE updated<?',(now-30*86400,))]
            for owner in stale:
                self.table().delete(f"owner_scope='{_hex(owner,64)}'")
                self.table(LINKS_TABLE).delete(f"owner_scope='{owner}'")
                self.conn.execute('DELETE FROM annotation_sync_jobs WHERE owner=?',(owner,))
        last=self.conn.execute('SELECT updated FROM annotation_maintenance WHERE id=1').fetchone()
        if not last or now-last[0]>86400:
            for name in (UNITS_TABLE,LINKS_TABLE):
                self.table(name).optimize(cleanup_older_than=timedelta(days=1))
            with self.conn:self.conn.execute('INSERT OR REPLACE INTO annotation_maintenance VALUES(1,?)',(now,))

    def search(self,data):
        owner=_hex(data['namespace'],64)
        mode=data.get('mode','hybrid');limit=min(100,int(data.get('limit',20)))
        q=self.query_vector(data['query']).tolist() if mode!='lexical' and data['items'] else None
        tokens=set(re.findall(r'\w+',data['query'].lower()))-set('how do does the a an of and to in my notes about are is'.split())
        candidates={};table=self.table()
        # Partition live IDs, not global top-k then permission filtering. Keeping
        # each partition's top-k cannot lose a global top-k authorized result.
        for start in range(0,len(data['items']),64):
            live=data['items'][start:start+64]
            where=authorized_filter(owner,[(r['bookId'],r['sourceVersion']) for r in live],[(r['id'],r['version']) for r in live])
            if q is not None:
                for row in table.search(q).distance_type('cosine').where(where,prefilter=True).limit(limit).to_list():
                    similarity=1-float(row['_distance'])
                    if similarity>=self.config.minimum_similarity:candidates[row['id']]={**row,'semanticSimilarity':similarity}
            if mode!='semantic':
                for row in table.search().where(where).limit(200).to_list():
                    count=len(tokens & set(re.findall(r'\w+',row['text'].lower())))
                    if count:
                        hit=candidates.setdefault(row['id'],row);hit['lexicalScore']=count
        rows=[]
        for row in candidates.values():
            similarity=row.get('semanticSimilarity');lexical=row.get('lexicalScore',0)
            # Same score contract across partitions; not a confidence probability.
            rows.append({'id':row['annotation_id'],'unitId':row['id'],'kind':row['kind'],'version':row['annotation_version'],
                         'semanticSimilarity':similarity,'score':(similarity or 0)+min(lexical,5)*0.1,
                         'embeddingProvenance':row['embedding_provenance']})
        rows.sort(key=lambda r:(-r['score'],r['unitId']))
        links=self.table(LINKS_TABLE)
        for row in rows[:limit]:
            live=next(r for r in data['items'] if r['id']==row['unitId'])
            row['sourceLinks']=[{'passageId':r['passage_id'],'sourceVersion':r['source_version'],'section':r['section'],
                                'charStart':r['char_start'],'charEnd':r['char_end'],'method':r['match_method']}
                for r in links.search().where(f"owner_scope='{owner}' AND unit_id='{row['unitId']}' AND annotation_version='{row['version']}' AND source_version='{live['sourceVersion']}'").limit(4).to_list()]
        return rows[:limit]

    def status(self,data):
        owner=_hex(data['namespace'],64)
        job=self.conn.execute('SELECT state,scanned,total,updated,error FROM annotation_sync_jobs WHERE owner=?',(owner,)).fetchone()
        return {'backend':'lancedb-atomic-v1','storedUnits':self.table().count_rows(f"owner_scope='{owner}'"),
                'state':job[0] if job else 'not-synced','scanned':job[1] if job else 0,
                'totalOwnAnnotations':job[2] if job else None,'updatedAt':job[3] if job else None,
                'error':job[4] if job else None,'countsAreCachedNotAuthorization':True}

    def failed(self,data):
        owner=_hex(data['namespace'],64)
        with self.conn:
            self.conn.execute('INSERT OR REPLACE INTO annotation_sync_jobs VALUES(?,?,?,?,?,?)',
                (owner,'incomplete',data.get('scanned',0),data.get('total',0),time.time(),
                 'Sync incomplete; completed units retained for retry'))
