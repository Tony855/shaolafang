#!/bin/bash
rsync -a --delete --exclude node_modules --exclude .git --exclude .env --exclude NUL --exclude uploads --exclude data --exclude backups --exclude logs --exclude '*.log' /mnt/c/Users/DONGFeng/Downloads/shaolafang/ /root/foodflow/
systemctl restart foodflow
sleep 3
systemctl is-active foodflow
curl -s -o /dev/null -w 'home: %{http_code}\n' http://localhost:3000/
curl -s -o /dev/null -w 'admin: %{http_code}\n' http://localhost:3000/admin
curl -s -o /dev/null -w 'health: %{http_code}\n' http://localhost:3000/api/health
