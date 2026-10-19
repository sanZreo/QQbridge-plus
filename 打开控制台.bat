@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 打开 qq-bridge 网页控制台。
rem 控制台需要 token（在 state/console-token 里），所以不能直接开 http://127.0.0.1:3100。

set "TOKENFILE=%~dp0state\console-token"

if not exist "%TOKENFILE%" (
    echo.
    echo [错误] 找不到 %TOKENFILE%
    echo         说明桥接还没启动过。请先运行 start.bat。
    echo.
    pause
    exit /b 1
)

set /p TOKEN=<"%TOKENFILE%"
if "%TOKEN%"=="" (
    echo.
    echo [错误] token 文件是空的。请先运行 start.bat 让它生成。
    echo.
    pause
    exit /b 1
)

echo.
echo 正在打开控制台...
echo   地址: http://127.0.0.1:3100/?token=%TOKEN%
echo.

start "" "http://127.0.0.1:3100/?token=%TOKEN%"
exit /b 0
