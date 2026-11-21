'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'pages/admin/settings.js'),'utf8');
const keys=['telegramStoreNotifyGlobalEnabled','telegramStoreNotifyGlobalDisabled','telegramStoreNotifySaved','telegramStoreNotifySaveFailed'];
test('admin Telegram store notification settings use translated status and toast messages',()=>{
  for(const key of keys) assert.match(source,new RegExp("tAdmin\\(['\\\"]"+key+"['\\\"]\\)"));
  assert.doesNotMatch(source,/管理员 Bot 已启用；门店通知将发送到上方配置的 Chat|超级管理员尚未启用管理员 Bot|Telegram 门店通知设置已保存|Telegram 门店通知设置保存失败/);
  for(const locale of ['zh','en','vi','th','km']) { const dict=JSON.parse(fs.readFileSync(path.join(root,'locales',locale+'.json'),'utf8')); for(const key of keys) assert.equal(typeof dict[key],'string',locale+' missing '+key); }
});
