@echo off
set "WEBCLAW_BROWSER_ID=edge"
call "%~dp0run_host.bat" %*
exit /B %ERRORLEVEL%
