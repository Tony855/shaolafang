'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createFinancialReconciliationReviewService}=require('../server/services/financial-reconciliation-review');
const registerRoutes=require('../routes/financial-reconciliation');

function makeService(overrides={}) {
  const writes=[],reads=[];
  const deps={
    runAsync:async(sql,params=[])=>{writes.push({sql,params});if(sql.includes('INSERT IGNORE INTO financial_reconciliation_exception_alerts'))return {affectedRows:1};if(sql.includes('INSERT INTO financial_reconciliation_exception_alert_events'))return {affectedRows:1,insertId:88};return {affectedRows:1};},
    getAsync:async(sql,params=[])=>{reads.push({sql,params});if(sql.includes('SELECT id FROM financial_reconciliation_exception_alerts'))return {id:77};if(sql.includes('SELECT id,status FROM financial_reconciliation_exception_alerts'))return {id:77,status:'pending'};if(sql.includes('SELECT event_hash'))return null;return null;},
    allAsync:async(sql,params=[])=>{reads.push({sql,params});if(sql.includes('SELECT i.id AS item_id'))return [{item_id:11,batch_id:3},{item_id:12,batch_id:3}];return [];},
    withTransaction:async work=>work(),...overrides
  };
  return {service:createFinancialReconciliationReviewService(deps),writes,reads};
}

test('SLA alert generation is tenant-scoped, bounded, deduplicated and audited',async()=>{
  const {service,writes,reads}=makeService();
  const result=await service.generateSlaAlerts({merchantId:4,storeId:9,actorId:7,actorUsername:'finance',slaHours:24});
  assert.deepEqual(result,{slaHours:24,scanned:2,created:2,alreadyExisted:0});
  assert.equal(writes.filter(x=>x.sql.includes('INSERT IGNORE INTO financial_reconciliation_exception_alerts')).length,2);
  assert.equal(writes.filter(x=>x.sql.includes('INSERT INTO financial_reconciliation_exception_alert_events')).length,2);
  assert.ok(reads[0].sql.includes('i.merchant_id=?')&&reads[0].sql.includes('i.store_id=?'));
  assert.deepEqual(reads[0].params,[4,9,24]);
});
test('repeated SLA generation does not append duplicate alert events',async()=>{
  const {service,writes}=makeService({runAsync:async(sql)=>sql.includes('INSERT IGNORE INTO financial_reconciliation_exception_alerts')?{affectedRows:0}:{affectedRows:1}});
  const result=await service.generateSlaAlerts({merchantId:4,storeId:9,actorId:7,actorUsername:'finance',slaHours:24});
  assert.equal(result.created,0);assert.equal(result.alreadyExisted,2);
  assert.equal(writes.filter(x=>x.sql.includes('INSERT INTO financial_reconciliation_exception_alert_events')).length,0);
});
test('SLA generation validates threshold',async()=>{
  const {service}=makeService();
  await assert.rejects(service.generateSlaAlerts({merchantId:4,storeId:9,actorId:7,actorUsername:'finance',slaHours:0}),e=>e.code==='EXCEPTION_ALERT_SLA_INVALID');
});
test('SLA alert listing is scoped and validates pagination/status',async()=>{
  const {service,reads}=makeService({allAsync:async(sql,params)=>{reads.push({sql,params});return [{id:9,batch_id:3,item_id:11,alert_type:'sla_overdue',sla_hours:24,status:'pending',amount_minor:120,currency_code:'USD',age_seconds:90000}];}});
  const result=await service.listSlaAlerts({merchantId:4,storeId:9,status:'pending',limit:20});
  assert.equal(result.items[0].alertId,9);assert.equal(result.items[0].amountMinor,120);
  assert.ok(reads[0].sql.includes('a.merchant_id=?')&&reads[0].sql.includes('a.store_id=?'));
  await assert.rejects(service.listSlaAlerts({merchantId:4,storeId:9,status:'unknown'}),e=>e.code==='EXCEPTION_ALERT_FILTER_INVALID');
  await assert.rejects(service.listSlaAlerts({merchantId:4,storeId:9,limit:101}),e=>e.code==='EXCEPTION_ALERT_PAGINATION_INVALID');
});
test('SLA acknowledgement requires reason/key and appends a hash-linked audit event',async()=>{
  const {service,writes,reads}=makeService();
  const result=await service.acknowledgeSlaAlert({merchantId:4,storeId:9,actorId:7,actorUsername:'finance',alertId:77,reason:'Reviewed and assigned to finance',idempotencyKey:'sla-alert-ack-00000001'});
  assert.equal(result.replayed,false);assert.equal(result.eventId,88);
  assert.ok(reads.some(x=>x.sql.includes('merchant_id=? AND store_id=? FOR UPDATE')&&x.params[1]===4&&x.params[2]===9));
  assert.ok(writes.some(x=>x.sql.includes("status='acknowledged'")));
  assert.ok(writes.some(x=>x.sql.includes("VALUES (?,?,?,?,?,'acknowledged'")));
  await assert.rejects(service.acknowledgeSlaAlert({merchantId:4,storeId:9,actorId:7,actorUsername:'finance',alertId:77,reason:'no',idempotencyKey:'sla-alert-ack-00000002'}),/5 to 500/);
});
test('SLA alert routes enforce tenant context, thresholds and no-store reads',async()=>{
  const routes=new Map(),app={get(p,...h){routes.set('GET '+p,h);},post(p,...h){routes.set('POST '+p,h);}};
  registerRoutes(app,{runAsync:async()=>({affectedRows:1,insertId:1}),getAsync:async(sql)=>sql.includes('SELECT username')?{username:'finance'}:null,allAsync:async()=>[],withTransaction:async work=>work(),requireAdminKey:(_q,_s,n)=>n(),requirePermission:()=> (_q,_s,n)=>n()});
  const response=()=>({statusCode:200,body:null,headers:{},status(c){this.statusCode=c;return this;},setHeader(k,v){this.headers[k]=v;},json(b){this.body=b;return this;}});
  const generate=routes.get('POST /api/admin/financial-reconciliation/exceptions/alerts/generate').at(-1);
  const denied=response();await generate({merchantId:4,storeId:null,adminId:7,body:{}},denied);assert.equal(denied.statusCode,403);
  const invalid=response();await generate({merchantId:4,storeId:9,adminId:7,body:{slaHours:721}},invalid);assert.equal(invalid.statusCode,400);
  const list=routes.get('GET /api/admin/financial-reconciliation/exceptions/alerts').at(-1);
  const listed=response();await list({merchantId:4,storeId:9,adminId:7,query:{status:'pending'}},listed);assert.equal(listed.statusCode,200);assert.equal(listed.headers['Cache-Control'],'no-store, private');
});
test('alert inbox and report presets are wired through HTML, source and bundle',()=>{
  const root=path.join(__dirname,'..');
  const source=fs.readFileSync(path.join(root,'pages/admin/financial-reconciliation.js'),'utf8');
  const bundle=fs.readFileSync(path.join(root,'assets/admin-bundle.js'),'utf8');
  const html=fs.readFileSync(path.join(root,'admin.html'),'utf8');
  for(const id of ['financeSlaAlertList','financeSlaAlertGenerate','financeSlaAlertReload','financeReportLast7','financeReportLast30','financeReportThisMonth'])assert.ok(html.includes('id="'+id+'"'));
  assert.ok(source.includes('/exceptions/alerts?status=pending'));
  assert.ok(bundle.includes(source.trimEnd()));
});
