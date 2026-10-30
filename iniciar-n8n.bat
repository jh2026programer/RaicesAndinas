@echo off
chcp 65001 >nul
rem Version fija de n8n (evita actualizaciones automaticas al abrir) y sin envio de estadisticas
set N8N_DIAGNOSTICS_ENABLED=false
rem n8n se abre desde la carpeta del usuario para que NO lea el .env de la tienda
cd /d "%USERPROFILE%"
echo Iniciando n8n... (no cierres esta ventana)
start "" cmd /c "timeout /t 40 /nobreak >nul && start http://localhost:5678"
npx --yes n8n@2.42.5
