-- Migración 001: soporte para automatizaciones con n8n
-- El servidor la aplica automáticamente al iniciar (server.js), este archivo es de referencia.

-- Marca si el cliente pidió hablar con un asesor humano en ese chat
-- (para avisar al equipo una sola vez por conversación)
ALTER TABLE chats ADD COLUMN IF NOT EXISTS solicitud_asesor TINYINT(1) NOT NULL DEFAULT 0;
