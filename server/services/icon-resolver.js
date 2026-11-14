/* ============================================================
   server/services/icon-resolver.js — 图标文件名大小写不敏感解析

   问题：Linux 区分大小写，配置里写 'vietinbank.png'，实际文件
        可能是 'VietinBank.png'，前端 <img> 会 404。
   方案：启动时扫描图标目录，建 lowerName → realName 映射，
        API 返回前自动纠正。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ICON_DIR = path.join(__dirname, '..', '..', 'assets', 'vendor', 'payment-icons');

let _map = null;   // lowerName → realName

function buildMap() {
  const map = {};
  try {
    const files = fs.readdirSync(ICON_DIR);
    for (const f of files) {
      if (!/\.(png|jpg|jpeg|svg|webp|gif)$/i.test(f)) continue;
      map[f.toLowerCase()] = f;
    }
  } catch (e) {
    console.warn('[icon-resolver] 读取图标目录失败:', e.message);
  }
  return map;
}

/**
 * 把配置里的图标名解析成磁盘上真实存在的文件名
 * @param {string} name - 例如 'vietinbank.png'
 * @returns {string} 真实文件名（大小写正确），不存在则原样返回
 */
function resolveIcon(name) {
  if (!name) return name;
  if (!_map) _map = buildMap();
  const key = String(name).toLowerCase();
  // Missing bank-specific assets use the generic KHQR mark; never return a
  // configured filename that would create a broken image URL.
  return _map[key] || _map['khqr.png'] || name;
}

/** 手动刷新缓存（上传新图标后调用） */
function refresh() {
  _map = buildMap();
}

/** 列目录里所有图标（用于后台展示、排查） */
function listIcons() {
  if (!_map) _map = buildMap();
  return Object.values(_map);
}

/** 检查配置里的图标是否都存在，返回缺失列表 */
function findMissing(configuredNames) {
  if (!_map) _map = buildMap();
  const missing = [];
  for (const n of configuredNames) {
    if (!n) continue;
    if (!_map[String(n).toLowerCase()]) missing.push(n);
  }
  return missing;
}

module.exports = {
  resolveIcon,
  refresh,
  listIcons,
  findMissing,
  ICON_DIR,
};
