'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinancialReconciliationReviewService } = require('../server/services/financial-reconciliation-review');
const registerRoutes = require('../routes/financial-reconciliation');
function makeService(allAsync) {
  return createFinancialReconciliationReviewService({ runAsync: async () => ({ affectedRows: 1 }), getAsync: async () => null, allAsync, withTransaction: async work => work() });
}
test('exception operations summary scopes status, workload, trend, and overdue reminders', async () => {
  const calls=[];
  const service=makeService(async (sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('GROUP BY COALESCE(c.status')) return [
      {case_status:'open',case_count:3,overdue_count:2,age_under_24h:1,age_1_3d:1,age_3_7d:1,age_over_7d:0},
      {case_status:'in_progress',case_count:2,overdue_count:1,age_under_24h:0,age_1_3d:1,age_3_7d:0,age_over_7d:1}
    ];
    if(sql.includes('GROUP BY c.assigned_admin_id')) return [
      {assigned_admin_id:55,assigned_admin_username:'reviewer',active_count:3,overdue_count:2,oldest_age_seconds:90000},
      {assigned_admin_id:null,assigned_admin_username:null,active_count:2,overdue_count:1,oldest_age_seconds:800000}
    ];
    if(sql.includes('AS age_seconds')) return [{item_id:10,batch_id:4,exception_category:'fee',currency_code:'USD',amount_minor:250,external_reference:'bank-10',assigned_admin_id:null,assigned_admin_username:null,imported_at:'2026-11-10 10:00:00',age_seconds:90000}];
    if(sql.includes('AS opened_count')) return [{report_date:'2026-11-11',opened_count:4}];
    if(sql.includes('AS resolved_event_count')) return [{report_date:'2026-11-11',resolved_event_count:2}];
    return [];
  });
  const result=await service.getExceptionOperationsSummary({merchantId:4,storeId:9,slaHours:24});
  assert.deepEqual(result.summary,{openCount:3,inProgressCount:2,activeCount:5,overdueCount:3,ageing:{under24Hours:1,from1To3Days:2,from3To7Days:1,over7Days:1}});
  assert.equal(result.workload[0].adminId,55);
  assert.equal(result.workload[1].username,null);
  assert.equal(result.overdueItems[0].itemId,10);
  assert.deepEqual(result.trend,[{date:'2026-11-11',openedCount:4,resolvedEventCount:2}]);
  assert.equal(calls.length,5);
  for(const call of calls){assert.match(call.sql,/merchant_id=\?/);assert.match(call.sql,/store_id=\?/);assert.ok(call.params.includes(4));assert.ok(call.params.includes(9));}
});
test('exception operations summary validates SLA and defaults to 24 hours',async()=>{
  const service=makeService(async()=>[]);
  await assert.rejects(service.getExceptionOperationsSummary({merchantId:4,storeId:9,slaHours:0}),e=>e.code==='EXCEPTION_OPERATIONS_SLA_INVALID');
  await assert.rejects(service.getExceptionOperationsSummary({merchantId:4,storeId:9,slaHours:721}),e=>e.code==='EXCEPTION_OPERATIONS_SLA_INVALID');
  assert.equal((await service.getExceptionOperationsSummary({merchantId:4,storeId:9})).slaHours,24);
});
test('operations summary route enforces tenant context, SLA bounds, and no-store responses',async()=>{
  const routes=new Map(),app={get(path,...handlers){routes.set('GET '+path,handlers);},post(path,...handlers){routes.set('POST '+path,handlers);}};
  registerRoutes(app,{runAsync:async()=>({affectedRows:1}),getAsync:async()=>null,allAsync:async()=>[],withTransaction:async work=>work(),requireAdminKey:(_q,_s,n)=>n(),requirePermission:()=> (_q,_s,n)=>n()});
  const handler=routes.get('GET /api/admin/financial-reconciliation/exceptions/operations-summary').at(-1);
  const response=()=>({statusCode:200,body:null,headers:{},status(c){this.statusCode=c;return this;},setHeader(k,v){this.headers[k]=v;},json(b){this.body=b;return this;}});
  const denied=response();await handler({merchantId:4,storeId:null,adminId:7,query:{}},denied);assert.equal(denied.statusCode,403);
  const invalid=response();await handler({merchantId:4,storeId:9,adminId:7,query:{slaHours:'721'}},invalid);assert.equal(invalid.statusCode,400);
  const ok=response();await handler({merchantId:4,storeId:9,adminId:7,query:{slaHours:'12'}},ok);assert.equal(ok.statusCode,200);assert.equal(ok.body.slaHours,12);assert.equal(ok.headers['Cache-Control'],'no-store, private');
});
test('operations workbench source and bundle expose SLA, workload, trend, and reminders',()=>{
  const fs=require('node:fs'),path=require('node:path'),root=path.join(__dirname,'..');
  const source=fs.readFileSync(path.join(root,'pages/admin/financial-reconciliation.js'),'utf8');
  const bundle=fs.readFileSync(path.join(root,'assets/admin-bundle.js'),'utf8');
  const html=fs.readFileSync(path.join(root,'admin.html'),'utf8');
  for(const id of ['financeExceptionOpsSummary','financeExceptionOpsWorkload','financeExceptionOpsTrend','financeExceptionOpsOverdue']){assert.ok(source.includes('#'+id));assert.ok(html.includes('id="'+id+'"'));}
  assert.ok(source.includes('/operations-summary?slaHours='));
  assert.ok(bundle.includes(source));
});
