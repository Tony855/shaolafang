SELECT value FROM settings WHERE `key`='dual_currency_enabled';
SELECT value FROM settings WHERE `key`='secondary_currency_code';
SELECT COUNT(*) as total, SUM(active=0) as inactive, SUM(show_dual=1) as dual, SUM(secondary_currency_code='KHR') as khr FROM menus;
SELECT id, name, active, show_dual, secondary_currency_code, currency_code FROM menus LIMIT 5;
