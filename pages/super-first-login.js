'use strict';
(() => {
const form=document.getElementById('firstLoginForm'), oldPassword=document.getElementById('oldPassword'), newPassword=document.getElementById('newPassword'), confirmPassword=document.getElementById('confirmPassword'), button=document.getElementById('firstLoginBtn'), error=document.getElementById('firstLoginError');
if (!SLF.store.rawGet('superToken')) { window.location.replace('/super/login'); return; }
function strong(v) { return typeof v==='string' && v.length>=12 && v.length<=128 && [/[a-z]/,/[A-Z]/,/[0-9]/,/[^A-Za-z0-9]/].filter(r=>r.test(v)).length>=3; }
form.addEventListener('submit',async event=>{
event.preventDefault(); error.textContent='';
if(newPassword.value!==confirmPassword.value){error.textContent='两次输入的新密码不一致';confirmPassword.focus();return;}
if(!strong(newPassword.value)||newPassword.value===oldPassword.value){error.textContent='新密码强度不足，或与初始密码相同';newPassword.focus();return;}
button.disabled=true;button.textContent='正在安全保存…';
try {
const result=await SLF.api.post('/super/change-password',{oldPassword:oldPassword.value,newPassword:newPassword.value});
if(!result||result.success!==true)throw new Error((result&&result.error)||'密码更新失败');
SLF.store.rawRemove('superToken');SLF.store.rawRemove('superAdmin');
window.alert('密码已更新。为确保旧会话全部失效，请使用新密码重新登录。');window.location.replace('/super/login');
} catch(e) {
if(e&&e.status===503){SLF.store.rawRemove('superToken');SLF.store.rawRemove('superAdmin');window.alert(e.message||'凭据清理未完成，请使用新密码重新登录并重试。');window.location.replace('/super/login');return;}
error.textContent=e&&e.message?e.message:'密码更新失败，请重试';newPassword.value='';confirmPassword.value='';newPassword.focus();
} finally {button.disabled=false;button.textContent='保存新密码';}
});
document.getElementById('firstLoginLogout').addEventListener('click',async event=>{
event.preventDefault();try{await SLF.api.post('/super/logout',{});}catch(_){}SLF.store.rawRemove('superToken');SLF.store.rawRemove('superAdmin');window.location.replace('/super/login');
});
})();
