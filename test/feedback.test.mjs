import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {feedbackStore} from '../lib/feedback.mjs';
test('feedback persists anonymously and admin alone may list, review or delete',()=>{
 const db=new DatabaseSync(':memory:');let store=feedbackStore(db,()=>123);
 assert.throws(()=>store.submit('test',false));const {id}=store.submit(' Nice app ',true);
 assert.throws(()=>store.list(false));assert.throws(()=>store.count(false));assert.throws(()=>store.review(false,id));assert.throws(()=>store.remove(false,id));
 store=feedbackStore(db);assert.deepEqual(store.list(true),[{id,text:'Nice app',at:123,reviewed:0}]);assert.equal(store.count(true),1);
 store.review(true,id);assert.equal(store.count(true),0);store.remove(true,id);assert.equal(store.list(true).length,0);db.close();
});