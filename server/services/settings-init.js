/* ============================================================
   server/services/settings-init.js
   商户级 / 门店级 settings 默认值初始化
   ============================================================ */

const MERCHANT_DEFAULTS = {
  'payment_methods':          JSON.stringify({ cash: true, wechat: false, alipay: false, card: false }),
  'order_prefix_normal':      '11',
  'order_prefix_refund':      '01',
  'order_prefix_discount':    '21',
  'order_prefix_vip':         '61',
  'order_no_reset_period':    'never',
  'dual_currency_enabled':    '0',
};

const STORE_DEFAULTS = {
  'khqr_providers':           '[]',
  'khqr_migrated':            '1',
  'display_mode':             'grid',
  'display_order':            'default',
  'display_image_duration':   '8',
  'display_video_mode':       'full',
  'display_video_duration':   '15',
  'display_only_active':      '1',
  'display_show_price':       '1',
  'display_show_desc':        '1',
  'display_languages':        '["zh"]',
  'primary_currency_code':    'USD',
  'secondary_currency_code':  'KHR',
  'dual_currency_enabled':    '1',
  'new_order_sound_enabled':  '1',
};

async function initMerchantSettings(runAsync, merchantId) {
  if (!merchantId) return;
  for (const [k, v] of Object.entries(MERCHANT_DEFAULTS)) {
    await runAsync(
      "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=value",
      [`merchant_${merchantId}_${k}`, v]
    );
  }
}

async function initStoreSettings(runAsync, storeId) {
  if (!storeId) return;
  for (const [k, v] of Object.entries(STORE_DEFAULTS)) {
    await runAsync(
      "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=value",
      [`store_${storeId}_${k}`, v]
    );
  }
}

module.exports = {
  initMerchantSettings,
  initStoreSettings,
  MERCHANT_DEFAULTS,
  STORE_DEFAULTS,
};
