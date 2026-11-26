import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const scope={Blob,Uint8Array,DataView};
vm.runInNewContext(readFileSync(new URL('../public/metadata.js',import.meta.url),'utf8'),scope);
test('clean PNG removes ancillary metadata and trailing data',async()=>{
  const chunk=(type,data=[])=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);return Buffer.concat([len,Buffer.from(type),Buffer.from(data),Buffer.alloc(4)]);};
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',Array(13).fill(0)),chunk('eXIf',[1,2,3]),chunk('tEXt',[4,5]),chunk('iTXt',[6]),chunk('iCCP',[7]),chunk('IDAT',[8]),chunk('IEND'),Buffer.from('trailing')]);
  const clean=Buffer.from(await scope.QzuMetadata.stripPng(bytes).arrayBuffer());
  assert.equal(clean.includes('eXIf'),false);
  assert.equal(clean.includes('tEXt'),false);
  assert.equal(clean.includes('iTXt'),false);
  assert.equal(clean.includes('iCCP'),false);
  assert.equal(clean.includes('trailing'),false);
  assert.equal(clean.includes('IDAT'),true);
  assert.throws(()=>scope.QzuMetadata.stripPng(Buffer.from([1,2,3])));
});
