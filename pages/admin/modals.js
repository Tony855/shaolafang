/*
 * pages/admin/modals.js — 后台通用弹窗（确认框、密码框）
 * 依赖：core.js（SLF.t / SLF.ui）
 * 加载顺序：必须在 admin.js 之前
 */
(function(){
'use strict';

const tAdmin = SLF.t;

// ===== 确认弹窗 =====
let confirmCallback = null;
let confirmCancelCallback = null;

function showConfirm(message, callback, title, cancelCallback) {
    document.getElementById('confirmTitle').textContent = title || tAdmin('confirmTitle') || '确认操作';
    document.getElementById('confirmMessage').textContent = message;
    confirmCallback = callback;
    confirmCancelCallback = cancelCallback || null;
    document.getElementById('confirmModal').classList.add('open');
}

function hideConfirm() {
    document.getElementById('confirmModal').classList.remove('open');
    if (confirmCancelCallback) {
        const cb = confirmCancelCallback;
        confirmCallback = null;
        confirmCancelCallback = null;
        cb();
    } else {
        confirmCallback = null;
    }
}

function executeConfirm() {
    if (confirmCallback) confirmCallback();
    hideConfirm();
}

// ===== 密码输入弹窗 =====
let passwordCallback = null;

function showPasswordModal(message, callback, title) {
    document.getElementById('passwordModalTitle').textContent = title || tAdmin('passwordModalTitle') || '请输入密码';
    document.getElementById('passwordModalMessage').textContent = message || tAdmin('passwordModalMessage') || '请输入管理员密码以确认操作';
    document.getElementById('passwordModalInput').placeholder = tAdmin('passwordModalPlaceholder') || '请输入密码';
    document.getElementById('passwordModalInput').value = '';
    passwordCallback = callback;
    document.getElementById('passwordModal').classList.add('open');
    setTimeout(() => document.getElementById('passwordModalInput').focus(), 100);
}

function hidePasswordModal() {
    document.getElementById('passwordModal').classList.remove('open');
    passwordCallback = null;
}

function executePasswordModal() {
    const password = document.getElementById('passwordModalInput').value;
    if (!password) { SLF.ui.toast('❌ ' + (tAdmin('passwordModalPlaceholder') || '请输入密码')); return; }
    if (passwordCallback) passwordCallback(password);
    hidePasswordModal();
}

// 挂到 window（供 HTML 内联 onclick 和其他模块使用）
window.showConfirm = showConfirm;
window.hideConfirm = hideConfirm;
window.executeConfirm = executeConfirm;
window.showPasswordModal = showPasswordModal;
window.hidePasswordModal = hidePasswordModal;
window.executePasswordModal = executePasswordModal;

})();
