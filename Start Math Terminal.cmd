@echo off
node "%~dp0scripts\start-tabby.mjs" %*
if errorlevel 1 pause
