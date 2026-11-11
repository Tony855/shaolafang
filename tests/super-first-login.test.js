'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
const {removeInitialSuperAdminCredential}=require('../server/services/initial-credentials');
const {isStrongPassword}=require('../server/middleware/password');
const attachSuperRoutes=require('../routes/super');
const registerPageRoutes=require('../routes/pages');
const authSource=require('node:fs').readFileSync(path.join(__dirname,'../server/middleware/auth.js'),'utf8');
const serverSource=require('node:fs').readFileSync(path.join(__dirname,'../server.js'),'utf8');
async function fixture(content){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'foodflow-first-login-'));const file=path.join(dir,'initial-credentials.txt');if(content!==null)await fs.writeFile(file,content,{mode:0o600});return{dir,file,cleanup:()=>fs.rm(dir,{recursive:true,force:true})};}
test('initial credentials remove only matching super-admin and retain other protected entries',async t=>{
const f=await fixture('superAdmin: root / secret\\nmerchantAdmin: admin / merchant\\nwaiter: waiter / waiter-secret\\n');t.after(f.cleanup);
assert.deepEqual(await removeInitialSuperAdminCredential('root',{file:f.file}),{ok:true,removed:true});const c=await fs.readFile(f.file,'utf8');
assert.doesNotMatch(c,/secret\\nmerchantAdmin/);assert.match(c,/merchantAdmin: admin/);assert.match(c,/waiter: waiter/);assert.equal((await fs.stat(f.file)).mode&0o777,0o600);
});
test('initial credential cleanup refuses username mismatch and tolerates missing file',async t=>{
const f=await fixture('superAdmin: root / secret\\n');t.after(f.cleanup);assert.deepEqual(await removeInitialSuperAdminCredential('other',{file:f.file}),{ok:false,reason:'username_mismatch'});
const missing=path.join(f.dir,'missing');assert.deepEqual(await removeInitialSuperAdminCredential('root',{file:missing}),{ok:true,removed:false});
});
test('initial password policy requires length and three character classes',()=>{
assert.equal(isStrongPassword('lowercaseonlypassword'),false);assert.equal(isStrongPassword('Lowercase123'),true);assert.equal(isStrongPassword('lowercase123!'),true);assert.equal(isStrongPassword('UPPERCASE123!'),true);assert.equal(isStrongPassword('Aa1!short'),false);assert.equal(isStrongPassword('A'.repeat(129)+'a1!'),false);
});
test('server marks only a newly created super-admin for mandatory rotation',()=>{
assert.match(serverSource,/must_change_password TINYINT NOT NULL DEFAULT 0/);assert.match(serverSource,/ALTER TABLE super_admins ADD COLUMN must_change_password TINYINT NOT NULL DEFAULT 0/);assert.match(serverSource,/must_change_password\\) VALUES \\(\\?, \\?, \\?, 1\\)/);
});
test('super-admin middleware gate allows only password rotation and logout during first login',()=>{
assert.match(authSource,/Number\\(superAdmin\\.must_change_password\\) === 1/);assert.match(authSource,/api\\/super\\/change-password/);assert.match(authSource,/api\\/super\\/logout/);assert.match(authSource,/PASSWORD_CHANGE_REQUIRED/);
});
function appMock(){const routes={get:[],post:[],put:[],delete:[]};return{routes,get(p,...h){routes.get.push({path:p,handlers:h});},post(p,...h){routes.post.push({path:p,handlers:h});},put(p,...h){routes.put.push({path:p,handlers:h});},delete(p,...h){routes.delete.push({path:p,handlers:h});}};}
function response(){return{statusCode:200,headers:{},status(c){this.statusCode=c;return this;},setHeader(k,v){this.headers[k]=v;},json(b){this.body=b;return this;}};}
function deps(extra={}){const calls=[];return{calls,getAsync:async()=>null,runAsync:async(sql,params=[])=>{calls.push({sql,params});return{affectedRows:1};},allAsync:async()=>[],isLoginLocked:async()=>({locked:false}),recordLoginAttempt:async()=>{},resetLoginAttempts:async()=>{},cancelLoginAttempt:async()=>{},verifyPassword:()=>true,hashPassword:()=> 'new-hash',getClientIp:()=> '127.0.0.1',getLocationByIp:async()=>'',requireSuperAdmin:(_q,_s,n)=>n(),logAudit:async()=>{},collectBackupData:async()=>({}),autoBackupDatabase:async()=>{},withTransaction:async fn=>fn(),removeInitialSuperAdminCredential:async()=>({ok:true,removed:true}),...extra};}
test('forced rotation revokes all sessions and clears gate after cleanup',async()=>{
const app=appMock(),d=deps();attachSuperRoutes(app,d);const h=app.routes.post.find(x=>x.path==='/api/super/change-password').handlers.at(-1);
const req={body:{oldPassword:'Initial-password1!',newPassword:'New-Strong-Password2!'},superAdmin:{id:7,username:'root',password_hash:'old',must_change_password:1},superSessionToken:'old-token'};const res=response();await h(req,res);
assert.deepEqual(res.body,{success:true,reauthenticate:true});assert.ok(d.calls.some(x=>x.sql.includes('DELETE FROM super_sessions WHERE super_admin_id=?')&&x.params[0]===7));assert.ok(d.calls.some(x=>x.sql.includes('must_change_password=0')));assert.equal(d.calls.some(x=>x.sql.includes('token_hash<>?')),false);
});
test('weak first-login password is rejected without DB writes',async()=>{
const app=appMock(),d=deps();attachSuperRoutes(app,d);const h=app.routes.post.find(x=>x.path==='/api/super/change-password').handlers.at(-1);
const res=response();await h({body:{oldPassword:'initial',newPassword:'weak-password'},superAdmin:{id:7,username:'root',password_hash:'old',must_change_password:1}},res);assert.equal(res.statusCode,400);assert.equal(d.calls.length,0);
});
test('failed credential cleanup keeps first-login gate active',async()=>{
const app=appMock(),d=deps({removeInitialSuperAdminCredential:async()=>({ok:false})});attachSuperRoutes(app,d);const h=app.routes.post.find(x=>x.path==='/api/super/change-password').handlers.at(-1);
const res=response();await h({body:{oldPassword:'Initial-password1!',newPassword:'New-Strong-Password2!'},superAdmin:{id:7,username:'root',password_hash:'old',must_change_password:1}},res);
assert.equal(res.statusCode,503);assert.equal(d.calls.some(x=>x.sql.includes('must_change_password=0')),false);
});
test('first-login page is non-cacheable and contains new-password fields',()=>{
const routes=new Map(),a={get(ps,...hs){for(const p of Array.isArray(ps)?ps:[ps])routes.set(p,hs.at(-1));}};
registerPageRoutes(a,{getAsync:async()=>null,requireAdminKey:(_q,_s,n)=>n(),requirePermission:()=> (_q,_s,n)=>n()});
const h=routes.get('/super/first-login');assert.equal(typeof h,'function');const res={headers:{},body:'',setHeader(k,v){this.headers[k]=v;},send(v){this.body=v;}};
h({},res);assert.match(res.body,/firstLoginForm/);assert.match(res.body,/autocomplete="new-password"/);assert.equal(res.headers['Cache-Control'],'no-store, private');
});
