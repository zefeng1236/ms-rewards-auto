@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 MS Rewards 自动任务 (GUI) ...
if not exist node_modules (
  echo 首次运行，正在安装依赖（需联网，约 1-3 分钟）...
  call npm install
)
npm start
