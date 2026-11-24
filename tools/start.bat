@echo off
chcp 65001 >nul
title LanPlay 服务端
cd /d "%~dp0"
if not exist "LanPlay.exe" (
  echo 未找到 LanPlay.exe，请确认本文件与服务端在同一目录。
  pause
  exit /b 1
)
start "" "LanPlay.exe"
exit /b 0
