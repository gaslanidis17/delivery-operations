@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM Delivery Operations one-click launcher for Windows.
REM First run: creates local demo config, installs dependencies, and starts both
REM servers. Later runs reuse the installed dependencies.

cd /d "%~dp0"
title Delivery Operations Launcher

echo.
echo ============================================================
echo   Delivery Operations - one-click local demo
echo ============================================================
echo.

REM --- Pick Python -----------------------------------------------------------
set "PYTHON_RUNNER="
set "PYTHON_ARGS="
where py >nul 2>&1
if not errorlevel 1 (
  set "PYTHON_RUNNER=py"
  set "PYTHON_ARGS=-3"
)

if not defined PYTHON_RUNNER (
  where python >nul 2>&1
  if not errorlevel 1 set "PYTHON_RUNNER=python"
)

if not defined PYTHON_RUNNER (
  set "CODEX_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
  if exist "!CODEX_PYTHON!" set "PYTHON_RUNNER=!CODEX_PYTHON!"
)

if not defined PYTHON_RUNNER (
  echo ERROR: Python 3.11 or newer was not found.
  echo Install Python from https://www.python.org/downloads/ and run this file again.
  echo.
  pause
  exit /b 1
)

REM --- Pick a JavaScript package runner -------------------------------------
set "JS_RUNNER="
set "JS_INSTALL_ARGS="

where npm.cmd >nul 2>&1
if not errorlevel 1 (
  set "JS_RUNNER=npm.cmd"
  set "JS_INSTALL_ARGS=install"
)

if not defined JS_RUNNER (
  where pnpm.cmd >nul 2>&1
  if not errorlevel 1 (
    set "JS_RUNNER=pnpm.cmd"
    set "JS_INSTALL_ARGS=install --lockfile=false --ignore-scripts"
  )
)

if not defined JS_RUNNER (
  set "CODEX_PNPM=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
  set "CODEX_NODE_BIN=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
  if exist "!CODEX_PNPM!" if exist "!CODEX_NODE_BIN!\node.exe" (
    set "PATH=!CODEX_NODE_BIN!;!PATH!"
    set "JS_RUNNER=!CODEX_PNPM!"
    set "JS_INSTALL_ARGS=install --lockfile=false --ignore-scripts"
  )
)

if not defined JS_RUNNER (
  echo ERROR: Node.js 20 or newer was not found.
  echo Install Node.js from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

REM --- Create safe local demo configuration ---------------------------------
if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo [ok] Created .env in synthetic demo mode.
)

if not exist "users.json" (
  copy /y "users.json.example" "users.json" >nul
  echo [ok] Created local demo login accounts.
)

REM --- Backend setup ---------------------------------------------------------
if not exist "backend\venv\Scripts\python.exe" (
  echo [1/4] Creating the Python environment...
  "%PYTHON_RUNNER%" %PYTHON_ARGS% -m venv "backend\venv"
  if errorlevel 1 goto :setup_failed
)

echo [2/4] Checking backend dependencies...
"backend\venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r "backend\requirements.txt"
if errorlevel 1 goto :setup_failed

REM --- Frontend setup --------------------------------------------------------
if not exist "frontend\node_modules" (
  echo [3/4] Installing frontend dependencies...
  pushd "frontend"
  call "%JS_RUNNER%" %JS_INSTALL_ARGS%
  set "INSTALL_RESULT=%ERRORLEVEL%"
  popd
  if not "%INSTALL_RESULT%"=="0" goto :setup_failed
) else (
  echo [3/4] Frontend dependencies are ready.
)

if /I "%DELIVERY_OPERATIONS_VALIDATE_ONLY%"=="1" (
  echo [ok] Launcher validation completed.
  exit /b 0
)

REM --- Launch ---------------------------------------------------------------
echo [4/4] Starting Delivery Operations...
start "Delivery Operations Backend (:8000)" cmd /k "cd /d ""%~dp0backend"" && ""%~dp0backend\venv\Scripts\python.exe"" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload"
start "Delivery Operations Frontend (:5173)" cmd /k "cd /d ""%~dp0frontend"" && call ""%JS_RUNNER%"" run dev -- --host 127.0.0.1"

echo.
echo Delivery Operations is starting. Your browser will open automatically.
echo.
echo Demo login:
echo   Username: demo
echo   Password: delivery-demo
echo.
echo Close the Backend and Frontend windows to stop the app.

REM Wait until the frontend responds, then open it in the default browser.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$url='http://127.0.0.1:5173'; for($i=0;$i -lt 60;$i++){ try { Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1 ^| Out-Null; Start-Process $url; exit 0 } catch { Start-Sleep -Seconds 1 } }; Start-Process $url"

exit /b 0

:setup_failed
echo.
echo ERROR: Delivery Operations setup did not finish.
echo Review the message above, then run LAUNCH_APP.bat again.
echo.
pause
exit /b 1
