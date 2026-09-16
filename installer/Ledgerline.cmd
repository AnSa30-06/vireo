@echo off
rem Launch Ledgerline using the bundled Node runtime.
setlocal
set "HERE=%~dp0"
set "PATH=%HERE%node;%PATH%"
"%HERE%node\node.exe" "%HERE%app\bin\ledgerline.mjs" %*
if errorlevel 1 (
  echo.
  echo Ledgerline exited with an error.
  echo Run "Check Ledgerline health" from the Start Menu to diagnose it.
  echo.
  pause
)
endlocal
