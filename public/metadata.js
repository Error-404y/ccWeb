'use strict';
globalThis.QzuMetadata = (() => {
  const limit=2*1024*1024,inputLimit=20*1024*1024;
  const signature=[137,80,78,71,13,10,26,10];
  function stripPng(bytes) {
    if(bytes.length<8||signature.some((v,i)=>bytes[i]!==v))throw Error('Invalid image encoding.');
    const parts=[bytes.subarray(0,8)],view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    let pos=8,header=false,pixels=false,ended=false;
    while(pos+12<=bytes.length){
      const length=view.getUint32(pos),end=pos+12+length;
      if(end>bytes.length)throw Error('Invalid image encoding.');
      const type=String.fromCharCode(...bytes.subarray(pos+4,pos+8));
      if(!header&&type!=='IHDR')throw Error('Invalid image encoding.');
      if(type==='IHDR'){if(header||length!==13)throw Error('Invalid image encoding.');header=true;}
      if(type==='IDAT')pixels=true;
      if(['IHDR','PLTE','IDAT','IEND','tRNS'].includes(type))parts.push(bytes.subarray(pos,end));
      else if(type[0]===type[0].toUpperCase())throw Error('Unsupported image encoding.');
      pos=end;
      if(type==='IEND'){if(length!==0)throw Error('Invalid image encoding.');ended=true;break;}
    }
    if(!header||!pixels||!ended)throw Error('Invalid image encoding.');
    return new Blob(parts,{type:'image/png'});
  }
  function photoGeometry(width,height,rotation=0,ratio=null) {
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width*height>40000000)throw Error('Image dimensions are too large.');
    if(![0,90,180,270].includes(rotation)||(ratio!==null&&(!Number.isFinite(ratio)||ratio<0.25||ratio>4)))throw Error('Invalid photo edit.');
    const sideways=rotation===90||rotation===270;
    const sourceRatio=ratio===null?width/height:sideways?1/ratio:ratio;
    const w=Math.min(width,height*sourceRatio),h=Math.min(height,width/sourceRatio);
    return {x:(width-w)/2,y:(height-h)/2,w,h,width:sideways?h:w,height:sideways?w:h};
  }
  async function cleanImage(blob,{rotation=0,ratio=null}={}) {
    if(!blob?.size||blob.size>inputLimit||!['image/jpeg','image/png','image/webp'].includes(blob.type))throw Error('Choose a JPG, PNG or WebP under 20 MB.');
    const url=URL.createObjectURL(blob),image=new Image(),canvas=document.createElement('canvas');
    try {
      await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('Image could not be decoded.'));image.src=url;});
      const crop=photoGeometry(image.naturalWidth,image.naturalHeight,rotation,ratio);
      const sideways=rotation===90||rotation===270;
      let scale=Math.min(1,2048/Math.max(crop.width,crop.height));
      for(let attempt=0;attempt<7;attempt++){
        canvas.width=Math.max(1,Math.round(crop.width*scale));canvas.height=Math.max(1,Math.round(crop.height*scale));
        const ctx=canvas.getContext('2d');if(!ctx)throw Error('Image cleaning unavailable.');
        const w=sideways?canvas.height:canvas.width,h=sideways?canvas.width:canvas.height;
        ctx.translate(canvas.width/2,canvas.height/2);
        ctx.rotate(rotation*Math.PI/180);
        ctx.drawImage(image,crop.x,crop.y,crop.w,crop.h,-w/2,-h/2,w,h);
        const encoded=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('Image cleaning failed.')),'image/png'));
        const cleaned=stripPng(new Uint8Array(await encoded.arrayBuffer()));
        if(cleaned.size<=limit)return cleaned;
        scale*=0.72;
      }
      throw Error('Cleaned image is too large.');
    } finally {
      URL.revokeObjectURL(url);image.src='';canvas.width=0;canvas.height=0;
    }
  }
  return Object.freeze({cleanImage,stripPng,photoGeometry});
})();
