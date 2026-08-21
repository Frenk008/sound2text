@echo off
cd /d %~dp0
if not defined S2T_API_KEY echo [warn] S2T_API_KEY not set; transcription will fail. See README.
dsh web
