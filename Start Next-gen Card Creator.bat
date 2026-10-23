@echo off
title Next-gen Card Creator
cd /d "%~dp0"
if not exist node_modules (
  echo Installing for the first time...
  call npm install
)
start "" http://localhost:3100
echo Next-gen Card Creator is running. Close this window to stop it.
call npm run dev
