@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem node is NOT on this machine's PATH, so the interpreter must be spelled out.
rem Use the node bundled with DSH (v24.21.0).
rem IMPORTANT: the node.exe shipped with SnowLuma runs at Low integrity and FAILS
rem to inject into QQ (COMPONENT_LOAD_FAILED) -- do NOT use that one.
set "NODE=C:\Users\mechrevo\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" (
    echo [ERROR] node interpreter not found: %NODE%
    echo         Point the NODE variable at the top of this file to a valid node.exe.
    pause
    exit /b 1
)
rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
"%NODE%" scripts\harden-state-acl.mjs --quiet
rem Slang-learner event-chain diagnostics: set QQ_BRIDGE_DIAG_SLANG=1 and the bridge prints
rem every event received by the learner session to stdout (bypassing bridge.log), which is
rem how you debug "research task never gets its turn" style stalls.
if "%QQ_BRIDGE_DIAG_SLANG%"=="1" (
    echo [diag] QQ_BRIDGE_DIAG_SLANG=1 : printing slang-learner session event chain
    set "QQ_BRIDGE_DIAG_SLANG=1"
)
:loop
"%NODE%" src/bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
