@echo off
setlocal
cd /d %~dp0

echo ==============================================
echo  dsh-sound2text - install into DSH web profile
echo ==============================================

where node >nul 2>&1
if errorlevel 1 (
  echo [err] Node.js not found. Install Node 20+ first, then re-run.
  goto :fail
)
for /f "delims=" %%v in ('node --version') do echo [1/5] Node %%v

where dsh >nul 2>&1
if errorlevel 1 (
  echo [2/5] installing dsh CLI
  call npm install -g @deepseek-ai/dsh
  if errorlevel 1 goto :fail
) else (
  echo [2/5] dsh CLI ready
)
where pnpm >nul 2>&1
if errorlevel 1 (
  echo       installing pnpm
  call npm install -g pnpm
  if errorlevel 1 goto :fail
)

set "PY=%S2T_PYTHON%"
if not defined PY set "PY=python"
echo [3/5] installing Python deps with %PY%
"%PY%" -m pip install -q -r helper\requirements.txt
if errorlevel 1 (
  echo [warn] Python deps failed; capture will not work.
  echo        Set S2T_PYTHON to a valid interpreter and re-run.
)

echo [4/5] adding plugin into web profile
call dsh plugin --profile web add "%CD%"
if errorlevel 1 goto :fail

set "PATCH=%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml"
if not exist "%PATCH%" (
  echo [info] web profile not initialized yet.
  echo [info] Run "dsh web" once, stop it with Ctrl+C, then re-run this script.
  goto :fail
)
echo [5/5] patching cordis.patch.yml
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\patch-profile.ps1"
if errorlevel 1 goto :fail

echo.
echo ==============================================
echo  Done. Configure your ASR API key, either:
echo   A. setx S2T_API_KEY "sk-your-key"   (persistent, open a NEW terminal after)
echo   B. edit %PATCH%, add under sound2text config:
echo        apiKey: sk-your-key
echo  Optional: setx S2T_PYTHON "C:\path\to\python.exe"
echo  Then start with: dsh web
echo ==============================================
exit /b 0

:fail
echo [install] FAILED. Report the errors above.
exit /b 1
