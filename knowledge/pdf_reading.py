"""Bounded visual rendering and conservative optional text reading order."""
import base64
import hashlib
import re


def repeated_margins(doc,start,stop):
    occurrences={}
    for index in range(start,stop):
        page=doc[index]
        for block in page.get_text('blocks'):
            if block[6]!=0:continue
            x0,y0,x1,y1,text,*_=block
            if len(text)>160 or not (y1<page.rect.height*.08 or y0>page.rect.height*.92):continue
            key=re.sub(r'\d+','#',' '.join(text.split())).lower()
            if key:occurrences.setdefault(key,set()).add(index)
    return {key for key,pages in occurrences.items() if len(pages)>=2}


def layout_text(page,repeated):
    blocks=[];removed=0
    for block in page.get_text('blocks'):
        if block[6]!=0:continue
        x0,y0,x1,y1,text,*_=block
        key=re.sub(r'\d+','#',' '.join(text.split())).lower()
        margin=y1<page.rect.height*.08 or y0>page.rect.height*.92
        if margin and key in repeated:removed+=1;continue
        if text.strip():blocks.append((x0,y0,x1,y1,text))
    middle=page.rect.width/2
    left=[b for b in blocks if b[2]<middle-5]
    right=[b for b in blocks if b[0]>middle+5]
    columns=len(left)>=2 and len(right)>=2 and sum(len(b[4]) for b in left)>80 and sum(len(b[4]) for b in right)>80
    if not columns:
        return '\n'.join(b[4].rstrip() for b in sorted(blocks,key=lambda b:(b[1],b[0]))),{'columns':1,'removedMarginBlocks':removed}
    spanning=sorted([b for b in blocks if b not in left and b not in right],key=lambda b:b[1])
    pending=left+right;ordered=[]
    for anchor in spanning:
        above=[b for b in pending if b[3]<=anchor[1]]
        ordered.extend(sorted([b for b in above if b in left],key=lambda b:b[1]))
        ordered.extend(sorted([b for b in above if b in right],key=lambda b:b[1]))
        pending=[b for b in pending if b not in above];ordered.append(anchor)
    ordered.extend(sorted([b for b in pending if b in left],key=lambda b:b[1]))
    ordered.extend(sorted([b for b in pending if b in right],key=lambda b:b[1]))
    return '\n'.join(b[4].rstrip() for b in ordered),{'columns':2,'removedMarginBlocks':removed}


def render_pages(data,max_bytes):
    import pymupdf
    raw=base64.b64decode(data['data'],validate=True)
    if len(raw)>max_bytes:raise ValueError('PDF exceeds configured MiB limit')
    start,count=data.get('startPage',1),data.get('pageCount',1)
    if type(start) is not int or start<1 or type(count) is not int or not 1<=count<=2:
        raise ValueError('Visual PDF requests require 1-based pages and at most2pages')
    pages=[]
    with pymupdf.open(stream=raw,filetype='pdf') as doc:
        if doc.needs_pass:raise ValueError('Encrypted PDF requires an unlocked source')
        if len(doc)>2000:raise ValueError('PDF exceeds 2000-page extraction limit')
        if start>len(doc):raise ValueError('Page outside PDF')
        for index in range(start-1,min(start-1+count,len(doc))):
            page=doc[index];scale=min(2.,1600/max(page.rect.width,page.rect.height))
            pix=page.get_pixmap(matrix=pymupdf.Matrix(scale,scale),colorspace=pymupdf.csRGB,alpha=False)
            image=pix.tobytes('jpeg',jpg_quality=82)
            if len(image)>2*1024*1024:raise ValueError('Rendered page exceeds 2MiB response limit')
            pages.append({'page':index+1,'width':pix.width,'height':pix.height,'mimeType':'image/jpeg','data':base64.b64encode(image).decode()})
        return {'pages':pages,'totalPages':len(doc),'sha256':hashlib.sha256(raw).hexdigest()}
