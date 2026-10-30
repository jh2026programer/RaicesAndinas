@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Version fija de n8n (evita actualizaciones automaticas al abrir) y sin envio de estadisticas
set N8N_DIAGNOSTICS_ENABLED=false

echo ============================================
echo   Raices Andinas - Iniciando todo
echo ============================================
echo.
echo  IMPORTANTE: MySQL debe estar encendido en XAMPP.
echo.

rem n8n se abre desde la carpeta del usuario para que NO lea el .env de la tienda
start "n8n" /d "%USERPROFILE%" cmd /k "npx --yes n8n@2.42.5"
start "Tienda Raices Andinas" cmd /k "npm start"

echo  Se abrieron 2 ventanas: "n8n" y "Tienda Raices Andinas".
echo  NO las cierres mientras uses la tienda.
echo.
echo  Esperando a que arranquen (unos 40 segundos)...
timeout /t 40 /nobreak >nul

start "" http://localhost:5678
start "" http://localhost:3000
