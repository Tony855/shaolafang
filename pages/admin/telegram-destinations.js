/* pages/admin/telegram-destinations.js — merchant-scoped Telegram group subscriptions */
(function () {
  'use strict';

  const api = window.SLF && window.SLF.api;
  if (!api) return;

  const byId = id => document.getElementById(id);
  const text = (tag, value, className) => {
    const el = document.createElement(tag);
    el.textContent = String(value ?? '');
    if (className) el.className = className;
    return el;
  };
  const button = (label, onClick, className = 'display-settings-btn') => {
    const el = text('button', label, className);
    el.type = 'button';
    el.addEventListener('click', onClick);
    return el;
  };
  const check = (label, checked, onChange) => {
    const wrap = text('label', label, 'ff-check-row-lg');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    wrap.prepend(input);
    return wrap;
  };

  let snapshot = { destinations: [], availableStores: [] };

  async function refresh() {
    const list = byId('telegramDestinationsList');
    if (!list) return;
    list.replaceChildren(text('p', '正在加载群组与门店订阅…', 'ff-desc-tight'));
    try {
      snapshot = await api.get('/admin/telegram/destinations');
      render();
    } catch (error) {
      list.replaceChildren(text('p', error.message || '群组列表读取失败', 'ff-desc-tight'));
    }
  }

  async function saveSubscription(destination, storeId, values) {
    await api.put('/admin/telegram/destinations/' + destination.id + '/stores/' + storeId, values);
    await refresh();
  }

  function render() {
    const list = byId('telegramDestinationsList');
    if (!list) return;
    list.replaceChildren();
    const destinations = Array.isArray(snapshot.destinations) ? snapshot.destinations : [];
    const stores = Array.isArray(snapshot.availableStores) ? snapshot.availableStores : [];
    if (!destinations.length) {
      list.appendChild(text('p', '尚未登记群组。先添加 Bot 到 Telegram 群组，再获取 Chat ID 并登记。', 'ff-desc-tight'));
      return;
    }

    destinations.forEach(destination => {
      const card = text('section', '', 'settings-card');
      card.style.marginTop = '12px';
      const heading = text('h4', destination.title || (destination.chatType === 'supergroup' ? '超级群组' : '群组'));
      heading.style.margin = '0 0 6px';
      card.appendChild(heading);
      card.appendChild(text('p', destination.chatId + ' · ' + destination.chatType, 'ff-desc-tight'));

      const controls = text('div', '', 'settings-row');
      controls.style.gap = '10px';
      controls.style.flexWrap = 'wrap';
      controls.appendChild(check('启用此群组', destination.enabled, async enabled => {
        try {
          await api.put('/admin/telegram/destinations/' + destination.id, { enabled });
        } catch (error) {
          window.SLF.ui.toast('❌ ' + (error.message || '群组状态更新失败'));
        }
        await refresh();
      }));
      controls.appendChild(button('删除群组', async () => {
        try {
          await api.request('/admin/telegram/destinations/' + destination.id, { method: 'DELETE' });
          window.SLF.ui.toast('群组已删除');
          await refresh();
        } catch (error) {
          window.SLF.ui.toast('❌ ' + (error.message || '删除失败；请先移除全部门店订阅'));
        }
      }));
      card.appendChild(controls);

      const subscribed = new Set((destination.stores || []).map(item => Number(item.storeId)));
      const available = stores.filter(store => !subscribed.has(Number(store.id)));
      if (available.length) {
        const addRow = text('div', '', 'settings-row');
        addRow.style.gap = '8px';
        addRow.style.flexWrap = 'wrap';
        const select = document.createElement('select');
        select.className = 'ff-input-dark';
        select.style.minWidth = '180px';
        available.forEach(store => {
          const option = document.createElement('option');
          option.value = String(store.id);
          option.textContent = store.name + ' (#' + store.id + ')';
          select.appendChild(option);
        });
        addRow.appendChild(select);
        addRow.appendChild(button('添加门店订阅', async () => {
          try {
            await saveSubscription(destination, Number(select.value), {
              enabled: true, notifyOrderCreated: true, notifySettled: true, notifyRefunded: true
            });
            window.SLF.ui.toast('门店订阅已添加');
          } catch (error) {
            window.SLF.ui.toast('❌ ' + (error.message || '添加订阅失败'));
          }
        }));
        card.appendChild(addRow);
      }

      (destination.stores || []).forEach(subscription => {
        const row = text('div', '', 'settings-card');
        row.style.marginTop = '10px';
        row.style.padding = '12px';
        row.appendChild(text('strong', subscription.storeName || ('门店 #' + subscription.storeId)));
        const toggles = text('div', '', 'settings-form-grid');
        toggles.style.gridTemplateColumns = 'repeat(auto-fit,minmax(140px,1fr))';
        const fields = [
          ['启用订阅', 'enabled'],
          ['新订单', 'notifyOrderCreated'],
          ['收款确认', 'notifySettled'],
          ['退款完成', 'notifyRefunded']
        ];
        fields.forEach(([label, key]) => {
          toggles.appendChild(check(label, subscription[key], async value => {
            const next = {
              enabled: key === 'enabled' ? value : subscription.enabled,
              notifyOrderCreated: key === 'notifyOrderCreated' ? value : subscription.notifyOrderCreated,
              notifySettled: key === 'notifySettled' ? value : subscription.notifySettled,
              notifyRefunded: key === 'notifyRefunded' ? value : subscription.notifyRefunded
            };
            try {
              await saveSubscription(destination, subscription.storeId, next);
            } catch (error) {
              window.SLF.ui.toast('❌ ' + (error.message || '订阅设置保存失败'));
              await refresh();
            }
          }));
        });
        toggles.appendChild(button('移除此门店', async () => {
          const confirmed = await window.SLF.ui.confirm('确定从此群组移除此门店的订阅吗？');
          if (!confirmed) return;
          try {
            await api.request('/admin/telegram/destinations/' + destination.id + '/stores/' + subscription.storeId, { method: 'DELETE' });
            await refresh();
          } catch (error) {
            window.SLF.ui.toast('❌ ' + (error.message || '移除订阅失败'));
          }
        }));
        row.appendChild(toggles);
        card.appendChild(row);
      });
      list.appendChild(card);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const createButton = byId('createTelegramDestinationBtn');
    const chatInput = byId('telegramDestinationChatId');
    const titleInput = byId('telegramDestinationTitle');
    const discoverButton = byId('discoverTelegramDestinationChatsBtn');
    const discoveredSelect = byId('telegramDiscoveredDestinations');
    const hint = byId('telegramDestinationHint');
    if (createButton) createButton.addEventListener('click', async () => {
      try {
        await api.post('/admin/telegram/destinations', {
          chatId: chatInput ? chatInput.value.trim() : '',
          title: titleInput ? titleInput.value.trim() : ''
        });
        if (chatInput) chatInput.value = '';
        if (titleInput) titleInput.value = '';
        if (hint) hint.textContent = '群组登记成功。现在可以为此群组添加本商户的多个门店。';
        await refresh();
      } catch (error) {
        if (hint) hint.textContent = error.message || '群组登记失败';
      }
    });
    if (discoverButton) discoverButton.addEventListener('click', async () => {
      discoverButton.disabled = true;
      try {
        const result = await api.get('/admin/telegram/group-chats');
        const chats = Array.isArray(result.chats) ? result.chats : [];
        if (discoveredSelect) {
          discoveredSelect.replaceChildren();
          const placeholder = document.createElement('option');
          placeholder.value = '';
          placeholder.textContent = chats.length ? '选择已发现的群组…' : '暂未发现群组';
          discoveredSelect.appendChild(placeholder);
          chats.forEach(chat => {
            const option = document.createElement('option');
            option.value = String(chat.chatId || '');
            option.dataset.title = String(chat.title || '');
            option.textContent = (chat.title || '未命名群组') + ' (' + chat.type + ') — ' + chat.chatId;
            discoveredSelect.appendChild(option);
          });
          discoveredSelect.hidden = chats.length === 0;
        }
        if (hint) hint.textContent = result.hint || (chats.length ? '选择群组后登记；此操作不会自动保存。' : '暂未发现群组。');
      } catch (error) {
        if (hint) hint.textContent = error.message || '获取群组失败';
      } finally {
        discoverButton.disabled = false;
      }
    });
    if (discoveredSelect) discoveredSelect.addEventListener('change', () => {
      const option = discoveredSelect.selectedOptions[0];
      if (option && option.value && chatInput) {
        chatInput.value = option.value;
        if (titleInput) titleInput.value = option.dataset.title || '';
      }
    });
    const refreshButton = byId('refreshTelegramDestinationsBtn');
    if (refreshButton) refreshButton.addEventListener('click', refresh);
    refresh();
  });
})();
