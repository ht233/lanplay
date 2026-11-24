@echo off
REM LanPlay portable git wrapper.
REM No system-wide git on this machine; the repo uses the PortableGit in _toolchain\git.
REM Usage: tools\git.cmd status / tools\git.cmd log --oneline / ...
setlocal
set "GIT_EXE=%~dp0..\..\_toolchain\git\cmd\git.exe"
if not exist "%GIT_EXE%" (
  echo [LanPlay] Portable git not found: %GIT_EXE%
  echo Re-extract PortableGit there, or install git system-wide.
  exit /b 1
)
"%GIT_EXE%" %*
exit /b %ERRORLEVEL%
