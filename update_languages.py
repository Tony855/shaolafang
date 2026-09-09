#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
更新 languages.js：以英文为基准，补全所有翻译键
"""

import re
import json

# 读取现有 languages.js
with open('languages.js', 'r', encoding='utf-8-sig') as f:
    content = f.read()

# 翻译键映射（中文: (键名, 英文, 中文, 越南文, 泰文, 高棉文)）
# 以英文为基准母语，其他语言提供翻译
TRANSLATIONS = {
    # 打印机相关
    "printerManage": ("Receipt Printer Management", "小票打印机管理", "Quản lý máy in hóa đơn", "เครื่องพิมพ์ใบเสร็จ", "ម៉ាស៊ីនបោះពុម្ពវិក្កយបត្រ"),
    "addPrinter": ("Add Printer", "添加打印机", "Thêm máy in", "เพิ่มเครื่องพิมพ์", "បន្ថែមម៉ាស៊ីនបោះពុម្ព"),
    "networkPrinter": ("Network Printer", "网络打印机", "Máy in mạng", "เครื่องพิมพ์เครือข่าย", "ម៉ាស៊ីនបោះពុម្ពបណ្តាញ"),
    "bluetoothPrinter": ("Bluetooth Printer", "蓝牙打印机", "Máy in Bluetooth", "เครื่องพิมพ์บลูทูธ", "ម៉ាស៊ីនបោះពុម្ពប៊្លូធូស"),
    "usbPrinter": ("USB Printer", "USB打印机", "Máy in USB", "เครื่องพิมพ์ USB", "ម៉ាស៊ីនបោះពុម្ព USB"),
    "testPrint": ("Test Print", "测试打印", "In thử nghiệm", "พิมพ์ทดสอบ", "បោះពុម្ពសាកល្បង"),
    "connectionType": ("Connection Type", "连接类型", "Loại kết nối", "ประเภทการเชื่อมต่อ", "ប្រភេទការតភ្ជាប់"),
    "paper58mm": ("58mm Receipt Paper", "58mm 小票纸", "Giấy in 58mm", "กระดาษใบเสร็จ 58mm", "ក្រដាសវិក្កយបត្រ 58mm"),
    "paper80mm": ("80mm Receipt Paper", "80mm 小票纸", "Giấy in 80mm", "กระดาษใบเสร็จ 80mm", "ក្រដាសវិក្កយបត្រ 80mm"),
    "genericEscpos": ("Generic ESC/POS", "通用 ESC/POS", "ESC/POS chung", "ESC/POS ทั่วไป", "ESC/POS ទូទៅ"),
    "epson": ("EPSON", "EPSON 爱普生", "EPSON", "EPSON", "EPSON"),
    "bixolon": ("Bixolon", "Bixolon 毕索龙", "Bixolon", "Bixolon", "Bixolon"),
    "rongta": ("Rongta", "容大 Rongta", "Rongta", "Rongta", "Rongta"),
    "xprinter": ("Xprinter", "芯烨 Xprinter", "Xprinter", "Xprinter", "Xprinter"),
    "noPrinterHint": ("No printers yet. Add a network printer to start printing.", "暂无打印机，添加一台网络打印机开始打印", "Chưa có máy in. Thêm máy in mạng để bắt đầu in.", "ยังไม่มีเครื่องพิมพ์ เพิ่มเครื่องพิมพ์เครือข่ายเพื่อเริ่มพิมพ์", "មិនទាន់មានម៉ាស៊ីនបោះពុម្ព។ បន្ថែមម៉ាស៊ីនបោះពុម្ពបណ្តាញដើម្បីចាប់ផ្តើមបោះពុម្ព។"),
    "printerConnectHint": ("For best results, connect a printer and use network printing.", "请在连接打印机后使用网络打印功能获得最佳效果", "Để có kết quả tốt nhất, kết nối máy in và sử dụng in mạng.", "สำหรับผลลัพธ์ที่ดีที่สุด ให้เชื่อมต่อเครื่องพิมพ์และใช้การพิมพ์เครือข่าย", "សម្រាប់លទ្ធផលល្អបំផុត សូមតភ្ជាប់ម៉ាស៊ីនបោះពុម្ព និងប្រើការបោះពុម្ពបណ្តាញ។"),
    
    # 营业报表
    "dailyReport": ("Daily Report", "营业报表", "Báo cáo hàng ngày", "รายงานประจำวัน", "របាយការណ៍ប្រចាំថ្ងៃ"),
    "totalRevenue": ("Total Revenue", "总营业额", "Tổng doanh thu", "รายได้ทั้งหมด", "ប្រាក់ចំណូលសរុប"),
    "totalSales": ("Total Sales", "总营收", "Tổng doanh thu", "ยอดขายทั้งหมด", "ប្រាក់ចំណូលសរុប"),
    "totalOrders": ("Total Orders", "总订单数", "Tổng đơn hàng", "จำนวนคำสั่งซื้อทั้งหมด", "ចំនួនការបញ្ជាទិញសរុប"),
    "avgOrderValue": ("Avg. Order Value", "客单价", "Giá trị đơn hàng trung bình", "ค่าเฉลี่ยต่อออเดอร์", "តម្លៃមធ្យមការបញ្ជាទិញ"),
    "revenueByTable": ("Revenue by Table", "各桌台收入", "Doanh thu theo bàn", "รายได้ตามโต๊ะ", "ប្រាក់ចំណូលតាមតុ"),
    "exportMenuCsv": ("Export Menu CSV", "导出菜单CSV", "Xuất menu CSV", "ส่งออกเมนู CSV", "នាំចេញមឺនុយ CSV"),
    "exportOrdersCsv": ("Export Orders CSV", "导出订单CSV", "Xuất đơn hàng CSV", "ส่งออกออเดอร์ CSV", "នាំចេញការបញ្ជាទិញ CSV"),
    "exportSalesCsv": ("Export Sales CSV", "导出销量CSV", "Xuất doanh số CSV", "ส่งออกยอดขาย CSV", "នាំចេញយោងលក់ CSV"),
    "byMonth": ("By Month", "按月", "Theo tháng", "รายเดือน", "ប្រចាំខែ"),
    "endDate": ("End Date", "结束日期", "Ngày kết thúc", "วันที่สิ้นสุด", "កាលបរិច្ឆេទបញ្ចប់"),
    
    # 数据备份
    "dataBackup": ("Data Backup", "数据备份", "Sao lưu dữ liệu", "สำรองข้อมูล", "ការបម្រុងទុកទិន្នន័យ"),
    "backupNow": ("Backup Now", "立即备份", "Sao lưu ngay", "สำรองตอนนี้", "បម្រុងទុកឥឡូវនេះ"),
    "importBackup": ("Import Backup", "导入备份", "Nhập sao lưu", "นำเข้าสำรอง", "នាំចូលការបម្រុងទុក"),
    "exportBackup": ("Export Backup", "导出备份", "Xuất sao lưu", "ส่งออกสำรอง", "នាំចេញការបម្រុងទុក"),
    "resetDataWarning": ("Reset data will clear all orders", "重置数据将清空所有订单", "Đặt lại dữ liệu sẽ xóa tất cả đơn hàng", "รีเซ็ตข้อมูลจะล้างออเดอร์ทั้งหมด", "ការកំណត់ទិន្នន័យឡើងវិញនឹងលុបការបញ្ជាទិញទាំងអស់"),
    "resetOrderData": ("Reset Order Data", "重置订单数据", "Đặt lại dữ liệu đơn hàng", "รีเซ็ตข้อมูลออเดอร์", "កំណត់ទិន្នន័យការបញ្ជាទិញឡើងវិញ"),
    
    # 设置
    "saveDisplaySettings": ("Save Display Settings", "保存显示设置", "Lưu cài đặt hiển thị", "บันทึกการตั้งค่าการแสดงผล", "រក្សាទុកការកំណត់ការបង្ហាញ"),
    "enableDualCurrency": ("Enable Dual Currency Display", "启用双币显示", "Bật hiển thị đôi tiền tệ", "เปิดใช้งานการแสดงเงินสองสกุล", "បើកដំណើរការការបង្ហាញរូបិយប័ណ្ណពីរ"),
    "newOrderSound": ("New Order Sound", "新订单提示音", "Âm thông báo đơn hàng mới", "เสียงแจ้งออเดอร์ใหม่", "សំឡេងជូនដំណឹងការបញ្ជាទិញថ្មី"),
    "newOrderSoundDesc": ("Play sound on waiter and kitchen screens when new order arrives", "新订单到达时服务员端和后厨端播放提示音", "Phát âm thanh trên màn hình nhân viên và bếp khi có đơn hàng mới", "เล่นเสียงบนหน้าจอพนักงานและครัวเมื่อมีออเดอร์ใหม่", "ចាក់សំឡេងលើអេក្រង់អ្នកបម្រើ និងផ្ទះបាយនៅពេលមានការបញ្ជាទិញថ្មី"),
    "changeAdminPassword": ("Change Admin Password", "修改管理员密码", "Đổi mật khẩu quản trị", "เปลี่ยนรหัสผ่านแอดมิน", "ផ្លាស់ប្តូរពាក្យសម្ងាត់អ្នកគ្រប់គ្រង"),
    "oldPassword": ("Old Password", "旧密码", "Mật khẩu cũ", "รหัสผ่านเก่า", "ពាក្យសម្ងាត់ចាស់"),
    "newPassword": ("New Password", "新密码", "Mật khẩu mới", "รหัสผ่านใหม่", "ពាក្យសម្ងាត់ថ្មី"),
    "confirmNewPassword": ("Confirm New Password", "确认新密码", "Xác nhận mật khẩu mới", "ยืนยันรหัสผ่านใหม่", "បញ្ជាក់ពាក្យសម្ងាត់ថ្មី"),
    "passwordLeaveBlank": ("Leave blank to keep current password", "密码留空不修改", "Để trống để giữ mật khẩu hiện tại", "เว้นว่างเพื่อเก็บรหัสผ่านปัจจุบัน", "ទុកចន្លោះដើម្បីរក្សាពាក្យសម្ងាត់បច្ចុប្បន្ន"),
    "newPasswordOptional": ("New Password (leave blank to keep)", "新密码（留空不修改）", "Mật khẩu mới (để trống để giữ)", "รหัสผ่านใหม่ (เว้นว่างเพื่อเก็บ)", "ពាក្យសម្ងាត់ថ្មី (ទុកចន្លោះដើម្បីរក្សា)"),
    "min6Chars": ("At least 6 characters", "至少 6 位", "Tối thiểu 6 ký tự", "อย่างน้อย 6 ตัวอักษร", "យ៉ាងហោចណាស់ 6 តួអក្សរ"),
    "enterOldPassword": ("Please enter old password", "请输入旧密码", "Vui lòng nhập mật khẩu cũ", "กรุณากรอกรหัสผ่านเก่า", "សូមបញ្ចូលពាក្យសម្ងាត់ចាស់"),
    "enterPassword": ("Please enter password", "请输入密码", "Vui lòng nhập mật khẩu", "กรุณากรอกรหัสผ่าน", "សូមបញ្ចូលពាក្យសម្ងាត់"),
    "enterUsername": ("Please enter username", "请输入账号", "Vui lòng nhập tên đăng nhập", "กรุณากรอกชื่อผู้ใช้", "សូមបញ្ចូលឈ្មោះគណនី"),
    "enterName": ("Please enter name", "请输入姓名", "Vui lòng nhập tên", "กรุณากรอกชื่อ", "សូមបញ្ចូលឈ្មោះ"),
    "enterAddress": ("Please enter address", "请输入地址", "Vui lòng nhập địa chỉ", "กรุณากรอกที่อยู่", "សូមបញ្ចូលអាសយដ្ឋាន"),
    "enterStoreName": ("Please enter store name", "请输入店铺名称", "Vui lòng nhập tên cửa hàng", "กรุณากรอกชื่อร้าน", "សូមបញ្ចូលឈ្មោះហាង"),
    "enterStoreCode": ("Please enter store code", "请输入店铺编码", "Vui lòng nhập mã cửa hàng", "กรุณากรอกรหัสร้าน", "សូមបញ្ចូលលេខកូដហាង"),
    "enterCategoryName": ("Please enter category name", "请输入分类名称", "Vui lòng nhập tên danh mục", "กรุณากรอกชื่อหมวดหมู่", "សូមបញ្ចូលឈ្មោះប្រភេទ"),
    "selectLoginType": ("Please select login type", "请选择登录类型", "Vui lòng chọn loại đăng nhập", "กรุณาเลือกประเภทการเข้าสู่ระบบ", "សូមជ្រើសរើសប្រភេទការចូល"),
    
    # 服务员/店铺管理
    "waiterManage": ("Waiter Management", "服务员管理", "Quản lý nhân viên", "จัดการพนักงาน", "គ្រប់គ្រងអ្នកបម្រើ"),
    "addWaiter": ("Add Waiter", "添加服务员", "Thêm nhân viên", "เพิ่มพนักงาน", "បន្ថែមអ្នកបម្រើ"),
    "editWaiter": ("Edit Waiter", "编辑服务员", "Sửa nhân viên", "แก้ไขพนักงาน", "កែសម្រួលអ្នកបម្រើ"),
    "nameField": ("Name", "姓名", "Tên", "ชื่อ", "ឈ្មោះ"),
    "assignedStore": ("Assigned Store", "所属店铺", "Cửa hàng phụ trách", "ร้านที่สังกัด", "ហាងដែលជាប់កំណត់"),
    "permission": ("Permission", "权限", "Quyền hạn", "สิทธิ์", "សិទ្ធិ"),
    "storeManage": ("Store Management", "店铺管理", "Quản lý cửa hàng", "จัดการร้าน", "គ្រប់គ្រងហាង"),
    "addStore": ("Add Store", "添加店铺", "Thêm cửa hàng", "เพิ่มร้าน", "បន្ថែមហាង"),
    "editStore": ("Edit Store", "编辑店铺", "Sửa cửa hàng", "แก้ไขร้าน", "កែសម្រួលហាង"),
    "storeName": ("Store Name", "店铺名称", "Tên cửa hàng", "ชื่อร้าน", "ឈ្មោះហាង"),
    "storeCode": ("Store Code", "店铺编码", "Mã cửa hàng", "รหัสร้าน", "លេខកូដហាង"),
    "address": ("Address", "地址", "Địa chỉ", "ที่อยู่", "អាសយដ្ឋាន"),
    "noStore": ("No Store", "无店铺", "Không có cửa hàng", "ไม่มีร้าน", "គ្មានហាង"),
    "noStoreCheckDb": ("No stores found, please check database", "无店铺，请检查数据库", "Không tìm thấy cửa hàng, vui lòng kiểm tra cơ sở dữ liệu", "ไม่พบร้าน กรุณาตรวจสอบฐานข้อมูล", "មិនរកឃើញហាង សូមពិនិត្យមូលដ្ឋានទិន្នន័យ"),
    "copyMasterMenu": ("Copy Master Menu", "复制总店菜品", "Sao chép menu chính", "คัดลอกเมนูหลัก", "ចម្លងមឺនុយមេ"),
    "displayName": ("Display Name", "显示名称", "Tên hiển thị", "ชื่อที่แสดง", "ឈ្មោះបង្ហាញ"),
    
    # 桌台管理
    "tableManage": ("Table Management", "桌号管理", "Quản lý bàn", "จัดการโต๊ะ", "គ្រប់គ្រងតុ"),
    "tableAndQr": ("Tables & QR Codes", "桌号与固定二维码", "Bàn & mã QR", "โต๊ะและคิวอาร์โค้ด", "តុ និងកូដ QR"),
    "addTable": ("Add Table", "新增桌号", "Thêm bàn", "เพิ่มโต๊ะ", "បន្ថែមតុ"),
    "editTable": ("Edit Table", "编辑桌号", "Sửa bàn", "แก้ไขโต๊ะ", "កែសម្រួលតុ"),
    "tableName": ("Table Name", "桌号名称", "Tên bàn", "ชื่อโต๊ะ", "ឈ្មោះតុ"),
    "tablePlaceholder": ("Table (e.g. A07)", "桌号 (如 A07)", "Bàn (ví dụ A07)", "โต๊ะ (เช่น A07)", "តុ (ឧ. A07)"),
    "orderQrCode": ("Order QR Code", "点餐二维码", "Mã QR đặt hàng", "คิวอาร์โค้ดสั่งอาหาร", "កូដ QR បញ្ជាទិញ"),
    "scanToOrder": ("Scan to Order", "扫码点餐", "Quét mã để đặt hàng", "สแกนเพื่อสั่งอาหาร", "ស្កេនដើម្បីបញ្ជាទិញ"),
    "available": ("Available", "空闲", "Trống", "ว่าง", "ទំនេរ"),
    "occupied": ("Occupied", "已占", "Đang sử dụng", "ถูกใช้งาน", "កំពុងប្រើ"),
    "reserved": ("Reserved", "已预订", "Đã đặt trước", "จองแล้ว", "បានកក់"),
    
    # 菜品管理
    "menuManage": ("Menu Management", "菜品管理", "Quản lý thực đơn", "จัดการเมนู", "គ្រប់គ្រងមឺនុយ"),
    "addDish": ("Add Dish", "新增菜品", "Thêm món", "เพิ่มเมนู", "បន្ថែមមុខម្ហូប"),
    "addMenuItem": ("Add Menu Item", "添加菜品", "Thêm món ăn", "เพิ่มรายการเมนู", "បន្ថែមមុខម្ហូប"),
    "dishName": ("Dish Name", "菜品名称", "Tên món", "ชื่อเมนู", "ឈ្មោះមុខម្ហូប"),
    "dishDesc": ("Dish Description", "菜品描述", "Mô tả món", "คำอธิบายเมนู", "ការពិពណ៌នាមុខម្ហូប"),
    "dishCategory": ("Dish Category", "菜品分类", "Danh mục món", "หมวดหมู่เมนู", "ប្រភេទមុខម្ហូប"),
    "categoryManage": ("Category Management", "菜品分类管理", "Quản lý danh mục", "จัดการหมวดหมู่", "គ្រប់គ្រងប្រភេទម្ហូប"),
    "categoryName": ("Category Name", "分类名称", "Tên danh mục", "ชื่อหมวดหมู่", "ឈ្មោះប្រភេទ"),
    "newCategoryName": ("New Category Name", "新分类名称", "Tên danh mục mới", "ชื่อหมวดหมู่ใหม่", "ឈ្មោះប្រភេទថ្មី"),
    "editCategory": ("Edit Category", "编辑菜品分类", "Sửa danh mục", "แก้ไขหมวดหมู่", "កែសម្រួលប្រភេទម្ហូប"),
    "englishName": ("English Name", "英文名称", "Tên tiếng Anh", "ชื่อภาษาอังกฤษ", "ឈ្មោះភាសាអង់គ្លេស"),
    "englishDesc": ("English Description", "英文描述", "Mô tả tiếng Anh", "คำอธิบายภาษาอังกฤษ", "ការពិពណ៌នាភាសាអង់គ្លេស"),
    "unit": ("Unit", "单位", "Đơn vị", "หน่วย", "ឯកតា"),
    "price": ("Price", "价格", "Giá", "ราคา", "តម្លៃ"),
    "categoryPlaceholder": ("Category (e.g. Sichuan)", "分类 (如 川菜)", "Danh mục (ví dụ: Món Tứ Xuyên)", "หมวดหมู่ (เช่น สี่ชวน)", "ប្រភេទ (ឧ. ម្ហូបស៊ីឈួន)"),
    "iconPlaceholder": ("Icon (e.g. 🍖)", "图标（例如 🍖）", "Biểu tượng (ví dụ: 🍖)", "ไอคอน (เช่น 🍖)", "អាយកონ (ឧ. 🍖)"),
    "emojiPlaceholder": ("Emoji (e.g. 🍗)", "Emoji (如 🍗)", "Emoji (ví dụ: 🍗)", "อีโมจิ (เช่น 🍗)", "អ៊ីម៉ូជី (ឧ. 🍗)"),
    "nameLabel": ("Name", "名称", "Tên", "ชื่อ", "ឈ្មោះ"),
    "descLabel": ("Description", "描述", "Mô tả", "คำอธิบาย", "ការពិពណ៌នា"),
    "codeLabel": ("Code", "编码", "Mã", "รหัส", "លេខកូដ"),
    "symbolLabel": ("Symbol", "符号", "Ký hiệu", "สัญลักษณ์", "និមិត្តសញ្ញា"),
    "portLabel": ("Port", "端口", "Cổng", "พอร์ต", "ច្រក"),
    "ipPlaceholder": ("e.g. 192.168.1.100", "如：192.168.1.100", "ví dụ: 192.168.1.100", "เช่น 192.168.1.100", "ឧ. 192.168.1.100"),
    "currencyCodePlaceholder": ("e.g. CNY", "如：CNY", "ví dụ: CNY", "เช่น CNY", "ឧ. CNY"),
    "currencyNamePlaceholder": ("e.g. Chinese Yuan", "如：人民币", "ví dụ: Nhân dân tệ", "เช่น หยวนจีน", "ឧ. យន់ចិន"),
    "printerNamePlaceholder": ("e.g. Front Desk Printer", "如：前台小票机", "ví dụ: Máy in quầy lễ tân", "เช่น เครื่องพิมพ์แผนกหน้าร้าน", "ឧ. ម៉ាស៊ីនបោះពុម្ពថ្មស្បូវ"),
    "notePlaceholder": ("e.g. No cilantro, less spicy, takeaway...", "如：不要香菜、少辣、打包带走…", "ví dụ: Không ngò, ít cay, mang về...", "เช่น ไม่ใส่ผักชี เผ็ดน้อย พกไป...", "ឧ. កុំដាក់បន្លែចិន ហឹរតិច យកទៅ..."),
    "hotSale": ("Hot Sale", "热销", "Bán chạy", "ขายดี", "លក់ដាច់"),
    "enable": ("Enable", "启用", "Bật", "เปิดใช้งาน", "បើកដំណើរការ"),
    "disable": ("Disable", "停用", "Tắt", "ปิดใช้งาน", "បិទដំណើរការ"),
    "enabled": ("Enabled", "已启用", "Đã bật", "เปิดใช้งานแล้ว", "បានបើកដំណើរការ"),
    "disabled": ("Disabled", "已停用", "Đã tắt", "ปิดใช้งานแล้ว", "បានបិទដំណើរការ"),
    "listItem": ("List Item", "上架", "Đăng bán", "ขึ้นสู่หน้าร้าน", "ដាក់លក់"),
    "unlistItem": ("Unlist Item", "下架", "Ngừng bán", "ถอดจากหน้าร้าน", "ដកចេញពីការលក់"),
    
    # 订单管理
    "orderManage": ("Order Management", "订单管理", "Quản lý đơn hàng", "จัดการออเดอร์", "គ្រប់គ្រងការបញ្ជាទិញ"),
    "addOrder": ("Add Order", "新增订单", "Thêm đơn hàng", "เพิ่มออเดอร์", "បន្ថែមការបញ្ជាទិញ"),
    "activeOrders": ("Active Orders", "未完成订单", "Đơn hàng đang xử lý", "ออเดอร์ที่ยังไม่เสร็จ", "ការបញ្ជាទិញកំពុងប្រព្រឹត្ត"),
    "completedOrders": ("Completed Orders", "已结算订单", "Đơn hàng đã thanh toán", "ออเดอร์ที่ชำระแล้ว", "ការបញ្ជាទិញបានបង់ប្រាក់"),
    "orderDetails": ("Order Details", "订单详情", "Chi tiết đơn hàng", "รายละเอียดออเดอร์", "ព័ត៌មានលម្អិតការបញ្ជាទិញ"),
    "saveOrder": ("Save Order", "保存订单", "Lưu đơn hàng", "บันทึกออเดอร์", "រក្សាទុកការបញ្ជាទិញ"),
    "completeOrder": ("Complete Order", "完成订单", "Hoàn thành đơn hàng", "เสร็จสิ้นออเดอร์", "បញ្ចប់ការបញ្ជាទិញ"),
    "completed": ("Completed", "已完成", "Đã hoàn thành", "เสร็จสิ้น", "បានបញ្ចប់"),
    "cancelOrder": ("Cancel Order", "取消订单", "Hủy đơn hàng", "ยกเลิกออเดอร์", "បោះបង់ការបញ្ជាទិញ"),
    "cancelEdit": ("Cancel Edit", "取消编辑", "Hủy chỉnh sửa", "ยกเลิกการแก้ไข", "បោះបង់ការកែសម្រួល"),
    "searchOrderPlaceholder": ("Enter order ID to search", "输入订单号查询", "Nhập mã đơn hàng để tìm", "กรอกรหัสออเดอร์เพื่อค้นหา", "បញ្ចូលលេខសម្គាល់ការបញ្ជាទិញដើម្បីស្វែងរក"),
    "searchOrderOrTable": ("Search order ID or table...", "搜索订单ID或桌号...", "Tìm mã đơn hàng hoặc bàn...", "ค้นหารหัสออเดอร์หรือโต๊ะ...", "ស្វែងរកលេខសម្គាល់ការបញ្ជាទិញ ឬតុ..."),
    "searchBtn": ("Search", "查询", "Tìm kiếm", "ค้นหา", "ស្វែងរក"),
    "itemList": ("Item List", "菜品清单", "Danh sách món", "รายการเมนู", "បញ្ជីមុខម្ហូប"),
    "customerNoteOptional": ("Customer Note (optional)", "顾客备注（选填）", "Ghi chú khách hàng (tùy chọn)", "หมายเหตุลูกค้า (ไม่บังคับ)", "កត់សម្គាល់អតិថិជន (ស្រេចចិត្ត)"),
    "noteOptional": ("Note (optional)", "备注选填", "Ghi chú (tùy chọn)", "หมายเหตุ (ไม่บังคับ)", "កត់សម្គាល់ (ស្រេចចិត្ត)"),
    "note": ("Note", "备注", "Ghi chú", "หมายเหตุ", "កត់សម្គាល់"),
    "customerCall": ("Customer Call", "顾客呼叫", "Khách hàng gọi", "ลูกค้าเรียก", "អតិថិជនហៅ"),
    "refreshCallList": ("Refresh Call List", "刷新呼叫列表", "Làm mới danh sách gọi", "รีเฟรชรายการเรียก", "ធ្វើឱ្យបញ្ជីហៅថ្មី"),
    "noCalls": ("No Calls", "暂无呼叫", "Chưa có cuộc gọi", "ไม่มีการเรียก", "គ្មានការហៅ"),
    "serveDish": ("Serve Dish", "上菜", "Phục vụ món", "เสิร์ฟเมนู", "បម្រើម្ហូប"),
    "orderSuccess": ("Order Placed Successfully", "下单成功", "Đặt hàng thành công", "สั่งอาหารสำเร็จ", "បញ្ជាទិញជោគជ័យ"),
    "viewOrderDetails": ("Please view order details", "请移步到订单详情查看订单", "Vui lòng xem chi tiết đơn hàng", "กรุณาดูรายละเอียดออเดอร์", "សូមមើលព័ត៌មានលម្អិតការបញ្ជាទិញ"),
    
    # 预约管理
    "reservationManage": ("Reservation Management", "预约管理", "Quản lý đặt chỗ", "จัดการการจอง", "គ្រប់គ្រងការកក់"),
    "tableReservation": ("Table Reservation Management", "桌台预约管理", "Quản lý đặt bàn", "จัดการจองโต๊ะ", "គ្រប់គ្រងការកក់តុ"),
    "noReservations": ("No Reservations", "暂无预约", "Chưa có đặt chỗ", "ไม่มีการจอง", "គ្មានការកក់"),
    
    # 登录日志
    "loginLogs": ("Login Logs", "登录日志", "Nhật ký đăng nhập", "บันทึกการเข้าสู่ระบบ", "កំណត់ត្រាការចូល"),
    
    # 货币管理
    "currencyManage": ("Currency Management", "货币类型", "Quản lý tiền tệ", "จัดการสกุลเงิน", "គ្រប់គ្រងរូបិយប័ណ្ណ"),
    "addCurrency": ("Add Currency", "新增货币", "Thêm tiền tệ", "เพิ่มสกุลเงิน", "បន្ថែមរូបិយប័ណ្ណ"),
    "relativeToDefault": ("Relative to default currency", "相对默认货币", "So với tiền tệ mặc định", "เทียบกับสกุลเงินเริ่มต้น", "ធៀបនឹងរូបិយប័ណ្ណលំនាំដើម"),
    "exchangeRate": ("Exchange Rate", "汇率", "Tỷ giá", "อัตราแลกเปลี่ยน", "អត្រាប្តូរប្រាក់"),
    
    # 顾客端
    "enjoy": ("Enjoy", "味享", "Thưởng thức", "เพลิดเพลิน", "រីករាយ"),
    "connecting": ("Connecting...", "连接中", "Đang kết nối...", "กำลังเชื่อมต่อ...", "កំពុងតភ្ជាប់..."),
    "loading": ("Loading...", "加载中", "Đang tải...", "กำลังโหลด...", "កំពុងផ្ទុក..."),
    "loadFailed": ("Load Failed", "加载失败", "Tải thất bại", "โหลดล้มเหลว", "ការផ្ទុកបរាជ័យ"),
    "loadFailedRefresh": ("Load failed, please refresh", "加载失败请刷新", "Tải thất bại, vui lòng làm mới", "โหลดล้มเหลว กรุณารีเฟรช", "ការផ្ទុកបរាជ័យ សូមធ្វើឱ្យថ្មី"),
    "callWaiter": ("Call Waiter", "呼叫服务员", "Gọi nhân viên", "เรียกพนักงาน", "ហៅអ្នកបម្រើ"),
    "checkout": ("Checkout", "去结算", "Thanh toán", "ชำระเงิน", "បង់ប្រាក់"),
    "cart": ("Cart", "购物车", "Giỏ hàng", "ตะกร้า", "រទេះទិញ"),
    "confirmOrder": ("Confirm Order", "确认下单", "Xác nhận đặt hàng", "ยืนยันออเดอร์", "បញ្ជាក់ការបញ្ជាទិញ"),
    "selectDishes": ("Select Dishes", "选择菜品", "Chọn món", "เลือกเมนู", "ជ្រើសរើសមុខម្ហូប"),
    "currentTable": ("Current Table", "当前桌号", "Bàn hiện tại", "โต๊ะปัจจุบัน", "តុបច្ចុប្បន្ន"),
    "scanQrToBind": ("Please scan table QR code to bind table", "请扫描桌面二维码绑定桌号", "Vui lòng quét mã QR trên bàn để liên kết bàn", "กรุณาสแกนคิวอาร์โค้ดบนโต๊ะเพื่อผูกโต๊ะ", "សូមស្កេនកូដ QR លើតុដើម្បីភ្ជាប់តុ"),
    "verifyItemsBeforeSubmit": ("Please verify items and quantities before submitting", "请核对以下菜品和数量确认无误后提交", "Vui lòng kiểm tra món ăn và số lượng trước khi gửi", "กรุณาตรวจสอบเมนูและจำนวนก่อนส่ง", "សូមពិនិត្យមុខម្ហូប និងចំនួនមុនពេលដាក់ស្នើ"),
    "orderModifyNotice": ("Note: Orders cannot be modified or cancelled by customers. Please contact staff for changes.", "注意：无法自行修改和取消订单，如需修改或取消请联系商家", "Lưu ý: Không thể tự sửa hoặc hủy đơn hàng, vui lòng liên hệ nhân viên", "หมายเหตุ: ไม่สามารถแก้ไขหรือยกเลิกออเดอร์ได้เอง กรุณาติดต่อพนักงาน", "កត់សម្គាល់៖ មិនអាចកែសម្រួល ឬបោះបង់ការបញ្ជាទិញដោយខ្លួនឯងបានទេ សូមទាក់ទងបុគ្គលិក"),
    "thankYou": ("Thank You for Visiting", "感谢您的光临", "Cảm ơn quý khách đã ghé thăm", "ขอบคุณที่มาใช้บริการ", "អរគុណដែលបានមកទស្សនា"),
    "portion": ("portion", "份", "phần", "ส่วน", "មុខ"),
    "orderUnit": ("order(s)", "单", "đơn", "ออเดอร์", "ការបញ្ជាទិញ"),
    
    # 服务员端
    "waiterTerminal": ("Waiter Order Terminal", "服务员点餐终端", "Thiết bị đặt hàng nhân viên", "终端สั่งอาหารพนักงาน", "ថេប្លេតបញ្ជាទិញអ្នកបម្រើ"),
    "ordering": ("Ordering", "点餐", "Đặt hàng", "สั่งอาหาร", "បញ្ជាទិញ"),
    
    # 后厨端
    "kitchenLogin": ("Kitchen Login", "后厨登录", "Đăng nhập bếp", "เข้าสู่ระบบครัว", "ចូលផ្ទះបាយ"),
    "kitchenDisplay": ("Kitchen Order Display", "后厨订单显示", "Hiển thị đơn hàng bếp", "หน้าจอออเดอร์ครัว", "អេក្រង់ការបញ្ជាទិញផ្ទះបាយ"),
    "kitchenLoginDesc": ("Please use waiter account to login to kitchen display", "请使用服务员账号登录后厨显示屏", "Vui lòng sử dụng tài khoản nhân viên để đăng nhập màn hình bếp", "กรุณาใช้บัญชีพนักงานเพื่อเข้าสู่ระบบหน้าจอครัว", "សូមប្រើគណនីអ្នកបម្រើដើម្បីចូលអេក្រង់ផ្ទះបាយ"),
    "updatedAt": ("Updated at", "更新于", "Cập nhật lúc", "อัปเดตเมื่อ", "ធ្វើឱ្យថ្មីនៅ"),
    "fullscreen": ("Fullscreen", "全屏", "Toàn màn hình", "เต็มจอ", "ពេញអេក្រង់"),
    "noPendingOrders": ("No Pending Orders", "暂无待处理订单", "Chưa có đơn hàng chờ xử lý", "ไม่มีออเดอร์ที่รอ处理", "គ្មានការបញ្ជាទិញកំពុងរង់ចាំ"),
    "print": ("Print", "打印", "In", "พิมพ์", "បោះពុម្ព"),
    
    # 登录页
    "login": ("Login", "登录", "Đăng nhập", "เข้าสู่ระบบ", "ចូល"),
    "loginToBrand": ("Login to Roast House", "登录烧腊坊", "Đăng nhập vào Roast House", "เข้าสู่ระบบ Roast House", "ចូលប្រព័ន្ធ Roast House"),
    "waiter": ("Waiter", "服务员", "Nhân viên", "พนักงาน", "អ្នកបម្រើ"),
    "admin": ("Admin", "管理员", "Quản trị", "แอดมิน", "អ្នកគ្រប់គ្រង"),
    "username": ("Username", "用户名", "Tên đăng nhập", "ชื่อผู้ใช้", "ឈ្មោះគណនី"),
    "account": ("Account", "账号", "Tài khoản", "บัญชี", "គណនី"),
    "password": ("Password", "密码", "Mật khẩu", "รหัสผ่าน", "ពាក្យសម្ងាត់"),
    "adminPassword": ("Admin Password", "管理员密码", "Mật khẩu quản trị", "รหัสผ่านแอดมิน", "ពាក្យសម្ងាត់អ្នកគ្រប់គ្រង"),
    
    # 通用
    "save": ("Save", "保存", "Lưu", "บันทึก", "រក្សាទុក"),
    "delete": ("Delete", "删除", "Xóa", "ลบ", "លុប"),
    "edit": ("Edit", "编辑", "Sửa", "แก้ไข", "កែសម្រួល"),
    "cancel": ("Cancel", "取消", "Hủy", "ยกเลิก", "បោះបង់"),
    "close": ("Close", "关闭", "Đóng", "ปิด", "បិទ"),
    "exit": ("Exit", "退出", "Thoát", "ออก", "ចាកចេញ"),
    "logout": ("Logout", "退出登录", "Đăng xuất", "ออกจากระบบ", "ចាកចេញពីប្រព័ន្ធ"),
    "settings": ("Settings", "设置", "Cài đặt", "การตั้งค่า", "ការកំណត់"),
    "adminPanel": ("Admin Panel", "管理面板", "Bảng quản trị", "แผงแอดมิน", "បន្ទះអ្នកគ្រប់គ្រង"),
    "statistics": ("Statistics", "统计", "Thống kê", "สถิติ", "ស្ថិតិ"),
    "chinese": ("Chinese", "中文", "Tiếng Trung", "ภาษาจีน", "ភាសាចិន"),
    "english": ("English", "英文", "Tiếng Anh", "ภาษาอังกฤษ", "ភាសាអង់គ្លេស"),
    "default": ("Default", "默认", "Mặc định", "เริ่มต้น", "លំនាំដើម"),
    "done": ("Done", "完成", "Hoàn thành", "เสร็จสิ้น", "បានបញ្ចប់"),
    "group": ("Group", "分组", "Nhóm", "กลุ่ม", "ក្រុម"),
    "every6Hours": ("Every 6 Hours", "每 6 小时", "Mỗi 6 giờ", "ทุก 6 ชั่วโมง", "រាល់ 6 ម៉ោង"),
    "every12Hours": ("Every 12 Hours", "每 12 小时", "Mỗi 12 giờ", "ทุก 12 ชั่วโมง", "រាល់ 12 ម៉ោង"),
    "every24Hours": ("Every 24 Hours", "每 24 小时", "Mỗi 24 giờ", "ทุก 24 ชั่วโมง", "រាល់ 24 ម៉ោង"),
    "brandName": ("Roast House", "烧腊坊", "Roast House", "Roast House", "Roast House"),
    "adminBrand": ("Roast House Admin", "烧腊坊后台", "Roast House Admin", "Roast House Admin", "Roast House Admin"),
    "adminBrandFull": ("Roast House Management", "烧腊坊后台管理", "Quản lý Roast House", "การจัดการ Roast House", "ការគ្រប់គ្រង Roast House"),
    "appNameFull": ("Roast House QR Ordering System", "烧腊坊扫码点餐系统", "Hệ thống đặt hàng QR Roast House", "ระบบสั่งอาหาร QR Roast House", "ប្រព័ន្ធបញ្ជាទិញ QR Roast House"),
}

print(f"共定义 {len(TRANSLATIONS)} 个翻译键")

# 读取现有 languages.js 并解析
# 由于是 JS 文件，我们用简单的字符串处理
# 先找到每种语言的对象，然后添加缺失的键

# 语言代码顺序
lang_order = ['en', 'zh', 'vi', 'th', 'km']
lang_names = {'en': 'English', 'zh': '中文', 'vi': 'Tiếng Việt', 'th': 'ภาษาไทย', 'km': 'ភាសាខ្មែរ'}

# 读取文件
with open('languages.js', 'r', encoding='utf-8-sig') as f:
    lines = f.readlines()

# 找到每种语言的开始和结束位置
lang_positions = {}
for i, line in enumerate(lines):
    for lang in lang_order:
        if line.strip().startswith(f'{lang}: {{') or line.strip().startswith(f'{lang}:{{'):
            lang_positions[lang] = i
            break

print(f"\n语言位置: {lang_positions}")

# 对于每种语言，检查哪些键缺失，然后在结束前添加
# 我们需要找到每个语言对象的结束位置（大括号匹配）

def find_object_end(lines, start_line):
    """找到对象的结束大括号位置"""
    brace_count = 0
    started = False
    for i in range(start_line, len(lines)):
        for char in lines[i]:
            if char == '{':
                brace_count += 1
                started = True
            elif char == '}':
                brace_count -= 1
                if started and brace_count == 0:
                    return i
    return -1

# 为每种语言添加缺失的键
for lang in lang_order:
    if lang not in lang_positions:
        print(f"警告: 未找到语言 {lang}")
        continue
    
    start = lang_positions[lang]
    end = find_object_end(lines, start)
    
    if end == -1:
        print(f"警告: 未找到语言 {lang} 的结束位置")
        continue
    
    # 检查现有键
    existing_keys = set()
    for i in range(start, end):
        line = lines[i]
        # 匹配 key: value 格式
        import re
        match = re.match(r'\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:', line)
        if match:
            existing_keys.add(match.group(1))
    
    # 找出缺失的键
    missing_keys = [k for k in TRANSLATIONS if k not in existing_keys]
    
    if missing_keys:
        print(f"\n{lang} ({lang_names[lang]}): 缺失 {len(missing_keys)} 个键，正在添加...")
        
        # 在结束大括号前插入新键
        insert_lines = []
        insert_lines.append('')
        insert_lines.append(f'    // ---- 补充翻译（以英文为基准）----')
        for key in missing_keys:
            en, zh, vi, th, km = TRANSLATIONS[key]
            if lang == 'en':
                value = en
            elif lang == 'zh':
                value = zh
            elif lang == 'vi':
                value = vi
            elif lang == 'th':
                value = th
            elif lang == 'km':
                value = km
            
            # 转义引号
            value = value.replace('\\', '\\\\').replace("'", "\\'")
            insert_lines.append(f"    {key}: '{value}',")
        
        # 插入到结束大括号前
        lines[end:end] = [l + '\n' for l in insert_lines]
        
        # 更新后续语言的位置
        for other_lang in lang_order:
            if other_lang in lang_positions and lang_positions[other_lang] > end:
                lang_positions[other_lang] += len(insert_lines)
    else:
        print(f"{lang} ({lang_names[lang]}): ✓ 所有翻译键已存在")

# 写入更新后的文件
with open('languages.js', 'w', encoding='utf-8-sig') as f:
    f.writelines(lines)

print("\n✅ languages.js 更新完成！")
