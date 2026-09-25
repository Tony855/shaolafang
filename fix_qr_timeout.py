with open('routes/public-session.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 修改自动续期逻辑：只有已经有订单的session才自动续期，没下单的到时间就过期
old = '''      const qrTimeoutS = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
      const qrTimeoutMins = parseInt(qrTimeoutS?.value || '45', 10);
      if (qrTimeoutMins > 0) {
        const newQrExpires = new Date(Date.now() + qrTimeoutMins * 60 * 1000).toISOString();
        runAsync('UPDATE scan_sessions SET expires_at=? WHERE token=?', [newQrExpires, req.params.token]).catch(()=>{});
      }'''

new = '''      const qrTimeoutS = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
      const qrTimeoutMins = parseInt(qrTimeoutS?.value || '45', 10);
      if (qrTimeoutMins > 0) {
        // 只有已经有未结算订单的session才自动续期，没下单的到时间就过期
        const [orderCount] = await getAsync("SELECT COUNT(*) as cnt FROM orders WHERE table_name=? AND status='pending'", [session.table_name]);
        if (orderCount && orderCount.cnt > 0) {
          const newQrExpires = new Date(Date.now() + qrTimeoutMins * 60 * 1000).toISOString();
          runAsync('UPDATE scan_sessions SET expires_at=? WHERE token=?', [newQrExpires, req.params.token]).catch(()=>{});
        }
      }'''

if old in content:
    content = content.replace(old, new)
    print("修改自动续期逻辑成功！")
else:
    print("没找到要替换的内容")

# 同样修改/info接口里的续期逻辑
old2 = '''      const qrTimeoutS2 = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
      const qrTimeoutMins2 = parseInt(qrTimeoutS2?.value || '45', 10);
      let expiresAt2 = session.expires_at;
      if (qrTimeoutMins2 > 0) {
        expiresAt2 = new Date(Date.now() + qrTimeoutMins2 * 60 * 1000).toISOString();
        runAsync('UPDATE scan_sessions SET expires_at=? WHERE token=?', [expiresAt2, req.params.token]).catch(()=>{});
      }'''

new2 = '''      const qrTimeoutS2 = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
      const qrTimeoutMins2 = parseInt(qrTimeoutS2?.value || '45', 10);
      let expiresAt2 = session.expires_at;
      if (qrTimeoutMins2 > 0) {
        // 只有已经有未结算订单的session才自动续期，没下单的到时间就过期
        const [orderCount2] = await getAsync("SELECT COUNT(*) as cnt FROM orders WHERE table_name=? AND status='pending'", [session.table_name]);
        if (orderCount2 && orderCount2.cnt > 0) {
          expiresAt2 = new Date(Date.now() + qrTimeoutMins2 * 60 * 1000).toISOString();
          runAsync('UPDATE scan_sessions SET expires_at=? WHERE token=?', [expiresAt2, req.params.token]).catch(()=>{});
        }
      }'''

if old2 in content:
    content = content.replace(old2, new2)
    print("修改/info接口续期逻辑成功！")
else:
    print("没找到/info接口要替换的内容")

with open('routes/public-session.js', 'w', encoding='utf-8', newline='') as f:
    f.write(content)
