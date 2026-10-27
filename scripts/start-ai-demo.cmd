@echo off
powershell.exe -NoProfile -File "%~dp0start-ai-demo.ps1"
if errorlevel 1 pause
