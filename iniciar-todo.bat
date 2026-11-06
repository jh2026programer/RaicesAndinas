@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   Raices Andinas - Iniciando
echo ============================================
echo.
echo  IMPORTANTE: MySQL debe estar encendido en XAMPP.
echo.

rem Las automatizaciones ya viven en la tienda: no hace falta abrir n8n
start "Tienda Raices Andinas" cmd /k "npm start"

echo  Se abrio la ventana "Tienda Raices Andinas".
echo  NO la cierres mientras uses la tienda.
echo.
timeout /t 5 /nobreak >nul

start "" http://localhost:3000
