@echo off
setlocal enabledelayedexpansion
set "LOG=C:\Users\kaipol\.zcode\zcode-plus-final-phase.log"
set "NODE=D:\Scoop\apps\nodejs\current\node.exe"
echo [%date% %time%] === ZCode+ asar final phase started === > "%LOG%"
echo waiting 20s for agent session flush >> "%LOG%"
ping -n 21 127.0.0.1 >nul

set /a tries=0
:killloop
tasklist /FI "IMAGENAME eq ZCode.exe" 2>nul | find /I "ZCode.exe" >nul
if %errorlevel%==0 (
  set /a tries+=1
  if !tries! GTR 15 goto afterkill
  echo [%date% %time%] killing ZCode (attempt !tries!) >> "%LOG%"
  taskkill /IM ZCode.exe /F >> "%LOG%" 2>&1
  ping -n 4 127.0.0.1 >nul
  goto killloop
)
:afterkill
echo [%date% %time%] ZCode cleared after !tries! attempts >> "%LOG%"
ping -n 4 127.0.0.1 >nul

echo [%date% %time%] == zcode+ asar install == >> "%LOG%"
"%NODE%" "E:\zcode-model-hub-0.1.0\zcode+\asar-install.mjs" install >> "%LOG%" 2>&1
echo [%date% %time%] install exit=%errorlevel% >> "%LOG%"

echo [%date% %time%] == verify == >> "%LOG%"
"%NODE%" "E:\zcode-model-hub-0.1.0\zcode+\asar\verify-final.js" >> "%LOG%" 2>&1
set "VERIFY_OK=%errorlevel%"
echo [%date% %time%] verify exit=%VERIFY_OK% >> "%LOG%"

if "%VERIFY_OK%"=="0" (
  echo [%date% %time%] ALL DONE - shutting down now >> "%LOG%"
  shutdown -s -t 0
) else (
  echo [%date% %time%] FAILED - machine kept on for diagnosis, see log >> "%LOG%"
)
