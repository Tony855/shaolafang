'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createFinancialReconciliationReviewService}=require('../server/services/financial-reconciliation-review');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function snapshot(matchStatus,matchedJournalTransactionId,matchReason){return {matchStatus,matchedJournalTransactionId,matchReason,exceptionCategory:null,exceptionNote:null};}
function makeEvent({id,action,previousHash='',before,after,reason,journalTransactionId=null}){
 const merchantId=4,storeId=9,batchId=1,itemId=11,actorId=6,actorUsername='finance';
 const idempotencyKey='audit-verification-'+String(id).padStart(4,'0'),exceptionCategory=null;
 const requestHash=digest({merchantId,storeId,batchId,itemId,action,exceptionCategory,journalTransactionId,reason});
 const payload={merchantId,storeId,batchId,itemId,action,actorId,actorUsername,reason,idempotencyKey,requestHash,before,after,previousHash};
 return {id,merchant_id:merchantId,store_id:storeId,batch_id:batchId,item_id:itemId,journal_transaction_id:journalTransactionId,
  exception_category:exceptionCategory,actor_admin_id:actorId,actor_username:actorUsername,action,reason,idempotency_key:idempotencyKey,
  request_sha256:requestHash,before_json:JSON.stringify(before),after_json:JSON.stringify(after),previous_hash:previousHash,event_hash:digest(payload)};
}
function validEvents(){
 const first=makeEvent({id:1,action:'confirm',journalTransactionId:31,reason:'Verified against statement',
  before:snapshot('pending',null,null),after:snapshot('matched',31,'manual_confirm')});
 const second=makeEvent({id:2,action:'release',previousHash:first.event_hash,reason:'Release incorrect assignment',
  before:snapshot('matched',31,'manual_confirm'),after:snapshot('pending',null,'manual_release')});
 return [first,second];
}
function setup({events=validEvents(),batchExists=true}={}){
 const calls={batch:[],events:[],writes:0};
 const service=createFinancialReconciliationReviewService({
  runAsync:async()=>{calls.writes++;return {affectedRows:1};},
  getAsync:async(sql,params)=>{calls.batch.push({sql,params});if(!sql.includes('FROM financial_reconciliation_batches'))throw Error('unexpected read');
   return batchExists&&Number(params[0])===1&&Number(params[1])===4&&Number(params[2])===9?{id:1}:null;},
  allAsync:async(sql,params)=>{calls.events.push({sql,params});return events;},
  withTransaction:async work=>work()
 });
 return {service,calls};
}
test('verifies a complete multi-event chain and normalizes JSON key order',async()=>{
 const rows=validEvents();rows[0].before_json={exceptionNote:null,matchReason:null,matchedJournalTransactionId:null,matchStatus:'pending',exceptionCategory:null};
 const {service,calls}=setup({events:rows}),result=await service.verifyReviewHistory({merchantId:4,storeId:9,batchId:1});
 assert.equal(result.verified,true);assert.equal(result.complete,true);assert.equal(result.eventCount,2);
 assert.equal(result.firstEventId,1);assert.equal(result.lastEventId,2);assert.equal(result.headHash,rows[1].event_hash);
 assert.deepEqual(calls.batch[0].params,[1,4,9]);assert.deepEqual(calls.events[0].params,[4,9,1,10001]);
 assert.match(calls.events[0].sql,/merchant_id=\? AND store_id=\? AND batch_id=\?/);
 assert.match(calls.events[0].sql,/ORDER BY id ASC LIMIT \?/);assert.equal(calls.writes,0);
});
test('foreign batch returns not found without querying audit rows',async()=>{
 const {service,calls}=setup({batchExists:false});
 assert.equal(await service.verifyReviewHistory({merchantId:5,storeId:9,batchId:1}),null);
 assert.equal(calls.events.length,0);assert.equal(calls.writes,0);
});
test('detects a broken previous-hash link',async()=>{
 const rows=validEvents();rows[1].previous_hash='f'.repeat(64);
 const {service}=setup({events:rows}),result=await service.verifyReviewHistory({merchantId:4,storeId:9,batchId:1});
 assert.equal(result.verified,false);assert.equal(result.reason,'previous_hash_mismatch');assert.equal(result.firstInvalidEventId,2);
});
test('detects a changed request digest',async()=>{
 const rows=validEvents();rows[0].reason='A different reason was substituted';
 const {service}=setup({events:rows}),result=await service.verifyReviewHistory({merchantId:4,storeId:9,batchId:1});
 assert.equal(result.verified,false);assert.equal(result.reason,'request_hash_mismatch');assert.equal(result.firstInvalidEventId,1);
});
test('detects a changed snapshot while the request digest remains unchanged',async()=>{
 const rows=validEvents(),before=JSON.parse(rows[0].before_json);before.matchStatus='tampered';rows[0].before_json=JSON.stringify(before);
 const {service}=setup({events:rows}),result=await service.verifyReviewHistory({merchantId:4,storeId:9,batchId:1});
 assert.equal(result.verified,false);assert.equal(result.reason,'event_hash_mismatch');assert.equal(result.firstInvalidEventId,1);
});
test('rejects malformed or incomplete snapshots',async()=>{
 const rows=validEvents();rows[0].before_json='{"matchStatus":"pending"}';
 const {service}=setup({events:rows}),result=await service.verifyReviewHistory({merchantId:4,storeId:9,batchId:1});
 assert.equal(result.verified,false);assert.equal(result.reason,'invalid_snapshot');
});
test('detects invalid event metadata',async()=>{
 const rows=validEvents();rows[0].journal_transaction_id=null;
 const {service}=setup({events:rows}),result=await service.verifyReviewHistory({merchantId:4,storeId:9,batchId:1});
 assert.equal(result.verified,false);assert.equal(result.reason,'invalid_journal_reference');
});
test('refuses partial success when a chain exceeds 10000 events',async()=>{
 const first=validEvents()[0],rows=Array.from({length:10001},(_,index)=>({...first,id:index+1}));
 const {service}=setup({events:rows});
 await assert.rejects(service.verifyReviewHistory({merchantId:4,storeId:9,batchId:1}),e=>e.code==='REVIEW_AUDIT_VERIFY_LIMIT'&&e.limit===10000);
});
test('an empty chain is complete and read-only',async()=>{
 const {service,calls}=setup({events:[]}),result=await service.verifyReviewHistory({merchantId:4,storeId:9,batchId:1});
 assert.equal(result.verified,true);assert.equal(result.eventCount,0);assert.equal(result.headHash,'');assert.equal(calls.writes,0);
});
