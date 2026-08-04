@echo off
REM Launch the Electron desktop app for THIS checkout, from any directory.
REM
REM Runnable by absolute path from cmd, PowerShell or Git Bash: it resolves the
REM repo root from its own location, not the caller's cwd, so a worktree always
REM builds and serves itself. The renderer port comes from scripts/dev-port.mjs
REM (one per branch), so several worktrees can run side by side.
REM
REM CRLF line endings and plain ASCII only - cmd reads batch files in the OEM
REM codepage, so a UTF-8 dash in a comment becomes a bogus command.
setlocal
pushd "%~dp0.."
call npm run dev:electron
set EXITCODE=%ERRORLEVEL%
popd
endlocal & exit /b %EXITCODE%
