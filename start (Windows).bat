@echo off
:: PEZ$ Trading Terminal - Go Backend Launcher (Windows)
:: Double-click to start

cd /d "%~dp0"
set "PORT=5000"
set "SERVER_BIN=hyperliquid-server.exe"

echo ==================================================
echo   PEZ$ Trading Terminal - Go Backend
echo ==================================================
echo.

:: Kill existing server on configured port
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%PORT% ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 >nul

:: Build Go server from cmd/server.
:: Vendor-only + proxy off: builds entirely from the local vendor\ tree and can
:: never reach GitHub or any module proxy (fails loudly instead of fetching).
echo Building server...
set "GOFLAGS=-mod=vendor"
set "GOPROXY=off"
set "GOSUMDB=off"
go build -o "%SERVER_BIN%" ./cmd/server
if errorlevel 1 (
    echo Build failed!
    pause
    exit /b 1
)
echo Build successful

echo.
echo Starting server on http://localhost:%PORT%
echo Press Ctrl+C to stop
echo.

:: Run server from current folder (serves web\index.html and assets)
start "PEZ$ Server" /b "%SERVER_BIN%"

:: Wait for server to be ready. Startup restores the candle cache snapshot
:: (data\candle-snapshot.json.gz) before the port opens, and that file grows
:: with use -- allow up to 2 minutes.
echo Waiting for server to start...
set attempts=0
:waitloop
set /a attempts+=1
curl -fsS http://localhost:%PORT%/healthz >nul 2>&1
if %errorlevel% neq 0 (
    if %attempts% lss 120 (
        timeout /t 1 /nobreak >nul
        goto waitloop
    )
    echo Server failed to start!
    pause
    exit /b 1
)

echo Server ready

:: Open default browser
start http://localhost:%PORT%

echo Browser opened
echo Keep this window open while trading
echo.

:: Keep window open
pause
