@echo off
rem DevFlow one-command installer entry point.
rem Usage:  install.cmd [install.ps1 switches, e.g. -DryRun | -SkipPreset | -Profile web]
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%ERRORLEVEL%
endlocal & exit /b %RC%
