@echo off
rem Open the Ledgerline desktop app.
rem
rem The Desktop and Start Menu shortcuts point at Ledgerline.exe; this is the
rem same app started in a VISIBLE console, which is what "Ledgerline in a
rem terminal" runs. It exists so a failure the exe swallows can be read on
rem screen. It starts the gateway, the agent server and the interface, then
rem opens a window. Closing this console stops the agent.
setlocal
set "HERE=%~dp0"
set "PATH=%HERE%node;%PATH%"
title Ledgerline - keep this window open
"%HERE%node\node.exe" "%HERE%app\bin\ledgerline.mjs" ui
if errorlevel 1 (
  echo.
  echo Ledgerline could not start.
  echo Run "Check Ledgerline health" from the Start Menu to diagnose it.
  echo.
  pause
)
endlocal
