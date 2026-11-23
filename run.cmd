@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo Installing Unify dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)

node scripts\dev.mjs
exit /b %errorlevel%
