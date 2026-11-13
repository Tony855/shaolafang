#!/bin/bash
# ============================================================
# FoodFlow - NFS 共享存储服务器配置
# 适用：标准版和企业版集群部署
# 作用：共享菜品图片上传目录
#
# 安全约束：
# - 仅允许指定应用网段访问 NFSv4 TCP/2049。
# - 上传目录仅授予应用服务账号（默认 UID/GID 33）读写权限。
# - 保持 root_squash；客户端 root 不得映射为服务端 root。
# - 只替换 /export/uploads 对应的导出项，保留其他 /etc/exports 配置。
# ============================================================

set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
    echo "请使用 root 用户运行" >&2
    exit 1
fi

NFS_CLIENT_CIDR="${NFS_CLIENT_CIDR:-192.168.1.0/24}"
readonly NFS_UPLOAD_UID=33
readonly NFS_UPLOAD_GID=33
EXPORT_DIR="/export/uploads"

if [[ ! "${NFS_CLIENT_CIDR}" =~ ^([0-9]{1,3}[.]){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
    echo "NFS_CLIENT_CIDR 必须是 IPv4 CIDR，例如 192.168.1.0/24" >&2
    exit 1
fi

echo "=========================================="
echo "NFS 共享存储服务器安全配置"
echo "=========================================="

apt-get update -qq
apt-get install -y -qq nfs-kernel-server

# 与应用节点的 www-data 账号保持一致（Debian/Ubuntu 默认 UID/GID 为 33）。
if ! getent group www-data >/dev/null 2>&1; then
    groupadd --system --gid "${NFS_UPLOAD_GID}" www-data
fi
if ! getent passwd www-data >/dev/null 2>&1; then
    useradd --system --no-create-home --uid "${NFS_UPLOAD_UID}" --gid "${NFS_UPLOAD_GID}" --shell /usr/sbin/nologin www-data
fi
ACTUAL_UID="$(id -u www-data)"
ACTUAL_GID="$(id -g www-data)"
if [ "${ACTUAL_UID}" != "${NFS_UPLOAD_UID}" ] || [ "${ACTUAL_GID}" != "${NFS_UPLOAD_GID}" ]; then
    echo "www-data UID/GID 为 ${ACTUAL_UID}:${ACTUAL_GID}，与配置 ${NFS_UPLOAD_UID}:${NFS_UPLOAD_GID} 不一致。" >&2
    echo "请在所有应用节点统一 www-data UID/GID，或设置匹配的 NFS_UPLOAD_UID/NFS_UPLOAD_GID 后重试。" >&2
    exit 1
fi

# 目录不允许 other 用户写入；应用节点 www-data（UID/GID 33）可读写。
install -d -o "${NFS_UPLOAD_UID}" -g "${NFS_UPLOAD_GID}" -m 0770 "${EXPORT_DIR}"

# 原子更新 FoodFlow 自己的导出项，不覆盖服务器已有的其他 NFS exports。
touch /etc/exports
TEMP_EXPORTS="$(mktemp /etc/exports.foodflow.XXXXXX)"
trap 'rm -f "${TEMP_EXPORTS}"' EXIT
awk -v export_path="${EXPORT_DIR}" '$1 != export_path { print }' /etc/exports > "${TEMP_EXPORTS}"
printf '# FoodFlow uploads; restrict NFS_CLIENT_CIDR to trusted application nodes only.\n' >> "${TEMP_EXPORTS}"
printf '%s %s(rw,sync,no_subtree_check,root_squash)\n' "${EXPORT_DIR}" "${NFS_CLIENT_CIDR}" >> "${TEMP_EXPORTS}"
chown root:root "${TEMP_EXPORTS}"
chmod 0644 "${TEMP_EXPORTS}"
mv "${TEMP_EXPORTS}" /etc/exports
trap - EXIT

exportfs -ra
systemctl restart nfs-kernel-server
systemctl enable nfs-kernel-server

# NFSv4 使用 TCP/2049；仅为指定应用网段添加规则，不清空现有防火墙规则。
if command -v ufw >/dev/null 2>&1; then
    ufw allow from "${NFS_CLIENT_CIDR}" to any port 2049 proto tcp
fi

echo ""
echo "=========================================="
echo "NFS 服务器配置完成"
echo "=========================================="
echo "共享目录：${EXPORT_DIR}"
echo "客户端网段：${NFS_CLIENT_CIDR}"
echo "目录权限：${NFS_UPLOAD_UID}:${NFS_UPLOAD_GID}，0770"
echo "导出策略：rw,sync,no_subtree_check,root_squash"
echo ""
echo "在应用服务器上挂载："
echo "  sudo mkdir -p /mnt/shared/uploads"
echo "  sudo mount -t nfs -o vers=4 NFS_SERVER_IP:${EXPORT_DIR} /mnt/shared/uploads"
echo ""
echo "开机自动挂载（添加到 /etc/fstab）："
echo "  NFS_SERVER_IP:${EXPORT_DIR} /mnt/shared/uploads nfs4 rw,_netdev,hard,timeo=600,retrans=2 0 0"
echo ""
echo "请确认所有应用节点的 www-data UID/GID 与服务端一致（默认 33:33）。"
