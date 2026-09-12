#!/bin/bash
# ============================================================
# FoodFlow 系统 - 一键重新安装并初始化数据库
# 警告：此操作会删除所有现有数据，请先备份！
# ============================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}  FoodFlow 数据库重新初始化工具${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""
echo -e "${RED}⚠️  警告：此操作将删除所有现有数据！${NC}"
echo -e "${RED}   包括：商户、门店、菜品、订单、服务员等所有数据${NC}"
echo ""

# 确认操作
read -p "确定要重新初始化数据库吗？输入 YES 确认: " confirm
if [ "$confirm" != "YES" ]; then
    echo -e "${YELLOW}操作已取消${NC}"
    exit 0
fi

# 配置
PROJECT_DIR="/root/foodflow-main"
DB_NAME="ordering_system"
DB_USER="root"
DB_PASS="I9t1bcMe7mqKaNUR"
DB_PORT=3306

echo ""
echo -e "${GREEN}[1/6] 停止 Node 服务...${NC}"
cd $PROJECT_DIR
if [ -f "./restart.sh" ]; then
    # 尝试用项目脚本停止
    pkill -f "node server.js" || true
else
    pkill -f "node server.js" || true
fi
sleep 2
echo -e "${GREEN}✓ Node 服务已停止${NC}"

echo ""
echo -e "${GREEN}[2/6] 删除旧数据库...${NC}"
mysql -u$DB_USER -p$DB_PASS -P$DB_PORT -e "DROP DATABASE IF EXISTS $DB_NAME;" 2>/dev/null || true
echo -e "${GREEN}✓ 旧数据库已删除${NC}"

echo ""
echo -e "${GREEN}[3/6] 创建新数据库...${NC}"
mysql -u$DB_USER -p$DB_PASS -P$DB_PORT -e "CREATE DATABASE $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
echo -e "${GREEN}✓ 新数据库已创建${NC}"

echo ""
echo -e "${GREEN}[4/6] 启动 Node 服务（自动初始化表结构和默认数据）...${NC}"
cd $PROJECT_DIR

# 检查是否有 pm2
if command -v pm2 &> /dev/null; then
    pm2 restart server.js || pm2 start server.js --name foodflow
    echo -e "${GREEN}✓ 服务已通过 PM2 启动${NC}"
else
    # 后台启动
    nohup node server.js > /tmp/foodflow.log 2>&1 &
    echo -e "${GREEN}✓ 服务已后台启动${NC}"
fi

echo ""
echo -e "${GREEN}[5/6] 等待服务启动和数据库初始化...${NC}"
sleep 8

# 检查服务是否启动
if curl -s http://localhost:3000/ > /dev/null 2>&1; then
    echo -e "${GREEN}✓ 服务启动成功${NC}"
else
    echo -e "${YELLOW}⚠️  服务可能还在启动中，稍后请手动检查${NC}"
fi

echo ""
echo -e "${GREEN}[6/6] 验证数据库初始化...${NC}"
TABLE_COUNT=$(mysql -u$DB_USER -p$DB_PASS -P$DB_PORT -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME';" 2>/dev/null)
echo -e "${GREEN}✓ 已创建 $TABLE_COUNT 张表${NC}"

# 显示默认账号
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  数据库重新初始化完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "默认账号："
echo -e "  超级管理员：superadmin / super123"
echo -e "  商户管理员：admin / admin123"
echo -e "  服务员：waiter1 / 123456"
echo ""
echo -e "访问地址："
echo -e "  前端点餐：http://your-domain/"
echo -e "  商户后台：http://your-domain/admin"
echo -e "  服务员端：http://your-domain/waiter"
echo -e "  超级管理员：http://your-domain/super"
echo ""
echo -e "${YELLOW}提示：首次登录后请及时修改默认密码${NC}"
