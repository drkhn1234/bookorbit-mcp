"""Synthetic layout/render tests; no native books or external vision service."""
import base64
import unittest
import pymupdf
from pdf_reading import render_pages,layout_text,repeated_margins


def synthetic_pdf():
    doc=pymupdf.open()
    doc.set_metadata({'title':'MCP synthetic PDF ingestion validation','author':'Synthetic PDF Validation','subject':'Synthetic two-column physics and diagram test'})
    for i in range(2):
        p=doc.new_page(width=600,height=800)
        p.insert_text((40,25),'Synthetic repeated running header',fontsize=10)
        p.insert_textbox(pymupdf.Rect(40,100,270,165),'LEFT FIRST: Electric fields describe force per unit electric charge. '*2,fontsize=10)
        p.insert_textbox(pymupdf.Rect(40,200,270,280),'LEFT SECOND: Changing magnetic fields induce electric fields. '*2,fontsize=10)
        p.insert_textbox(pymupdf.Rect(330,100,560,165),'RIGHT FIRST: Maxwell equations unify electric and magnetic fields. '*2,fontsize=10)
        p.insert_textbox(pymupdf.Rect(330,200,560,280),'RIGHT SECOND: Waves carry energy and momentum through empty space. '*2,fontsize=10)
        p.insert_text((40,350),'Synthetic equation: E = F / q; wave speed c = 1 / sqrt(mu * epsilon).',fontsize=12)
        p.draw_line((120,470),(480,470),color=(0,0,0),width=2)
        p.draw_line((120,470),(120,390),color=(0,0,1),width=3)
        p.insert_text((125,390),'E',color=(0,0,1),fontsize=16)
        p.draw_line((120,470),(180,520),color=(1,0,0),width=3)
        p.insert_text((185,525),'B',color=(1,0,0),fontsize=16)
        p.insert_text((350,490),'Propagation direction',fontsize=11)
        p.insert_text((280,780),f'Page {i+1}',fontsize=10)
    return doc


class PdfReadingTests(unittest.TestCase):
    def test_two_column_order_and_repeated_margins(self):
        with synthetic_pdf() as doc:
            repeated=repeated_margins(doc,0,len(doc));text,info=layout_text(doc[0],repeated)
            self.assertEqual(info['columns'],2)
            self.assertLess(text.index('LEFT SECOND'),text.index('RIGHT FIRST'))
            self.assertNotIn('running header',text)
            self.assertEqual(info['removedMarginBlocks'],2)
            self.assertIn('Synthetic equation',text)

    def test_bounded_jpeg_render_keeps_page_provenance_and_rejects_bad_requests(self):
        with synthetic_pdf() as doc:encoded=base64.b64encode(doc.tobytes()).decode()
        args={'data':encoded,'startPage':2,'pageCount':1}
        result=render_pages(args,1024*1024)
        self.assertEqual(result['totalPages'],2)
        self.assertEqual(result['pages'][0]['page'],2)
        image=result['pages'][0]
        self.assertEqual(image['mimeType'],'image/jpeg')
        self.assertLessEqual(max(image['width'],image['height']),1600)
        self.assertTrue(base64.b64decode(image['data']).startswith(b'\xff\xd8'))
        for changed in [{'pageCount':3},{'startPage':0},{'startPage':3}]:
            with self.assertRaises(ValueError):render_pages({**args,**changed},1024*1024)
        with self.assertRaises(ValueError):render_pages(args,1)


if __name__=='__main__':unittest.main()
