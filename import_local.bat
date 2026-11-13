@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0" || exit /b 1
set "IMPORT_NODE="
node -e "const [a,b]=process.versions.node.split('.').map(Number); if(a<22||(a===22&&b<22))process.exit(1); require('node:sqlite')" >nul 2>&1
if not errorlevel 1 set "IMPORT_NODE=node"
if defined IMPORT_NODE goto ready
if exist "%ProgramFiles%\nodejs\node.exe" call :try_node "%ProgramFiles%\nodejs\node.exe"
if not defined IMPORT_NODE goto no_node
:ready
if not exist "node_modules\tsx\dist\cli.mjs" goto no_deps
"%IMPORT_NODE%" "node_modules\tsx\dist\cli.mjs" "scripts\local-import.ts" %*
set "IMPORT_EXIT=%ERRORLEVEL%"
popd
exit /b %IMPORT_EXIT%

:try_node
if not exist "%~1" exit /b
"%~1" -e "const [a,b]=process.versions.node.split('.').map(Number); if(a<22||(a===22&&b<22))process.exit(1); require('node:sqlite')" >nul 2>&1
if not errorlevel 1 set "IMPORT_NODE=%~1"
exit /b

:no_node
>&2 echo Node 22.22 or newer with node:sqlite is required. Install a supported Node runtime, then run import_local.bat again.
popd
exit /b 1

:no_deps
>&2 echo Local dependencies are missing. Run pnpm install from this repository, then run import_local.bat again.
popd
exit /b 1
