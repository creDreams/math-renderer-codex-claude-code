@echo off
if not exist "%~dp0dist\windows\AgentMath.exe" (
  echo Please build the Windows app first: npm run build:windows
  pause
  exit /b 1
)
start "" "%~dp0dist\windows\AgentMath.exe"
