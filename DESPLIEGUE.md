# Publicar Raíces Andinas en internet

Necesitas tres piezas: la **tienda** (Node.js), una **base de datos MySQL** y un **disco permanente** para las fotos de las facturas. Esta guía usa Railway porque ofrece las tres en un mismo lugar; el código no depende de Railway y sirve en otro proveedor.

> El crédito gratuito de Railway es limitado y las condiciones cambian: revisa [sus planes](https://docs.railway.com/pricing/plans) antes de empezar. Conviene publicar cerca de la entrega para que el crédito alcance hasta la sustentación.

## 1. Crear el proyecto

1. Entra a [railway.com](https://railway.com) con tu cuenta de GitHub.
2. **New Project → Deploy from GitHub repo** y elige `RaicesAndinas`.
3. En el proyecto: **New → Database → MySQL**.
4. En el servicio de la tienda: **Settings → Volumes**, crea un volumen montado en `/data`.
5. En **Settings → Networking**: **Generate Domain**. Anota la dirección.

## 2. Variables de la tienda (pestaña Variables)

Usa las referencias de Railway para la base de datos (`${{MySQL.MYSQLHOST}}`, etc.).

| Variable | Valor |
| --- | --- |
| `NODE_ENV` | `production` |
| `TIENDA_URL` | La dirección del paso 1, con `https://` |
| `ADMIN_TOKEN_SECRET` | Texto aleatorio largo (ver abajo) |
| `UPLOADS_DIR` | `/data` |
| `DB_HOST` · `DB_PORT` · `DB_USER` · `DB_PASSWORD` · `DB_NAME` | Referencias a `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD`, `MYSQLDATABASE` |
| `TIENDA_EMAIL_REMITENTE` · `ADMIN_EMAIL` | Tus correos |
| `ADMIN_TELEGRAM_CHAT_ID` · `TELEGRAM_BOT_TOKEN` | Tus datos de Telegram |
| `GEMINI_API_KEY` · `GROQ_API_KEY` | Tus claves de IA |
| `GMAIL_APP_PASSWORD` o `BREVO_API_KEY` | Ver el paso 5 |
| `ENCUESTA_ESPERA_MINUTOS` | `4320` (3 días), o menos para la demostración |
| `ADMIN_CORREO_INICIAL` · `ADMIN_PASSWORD_INICIAL` | El administrador real, con una contraseña **nueva** |

Para generar `ADMIN_TOKEN_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 3. Preparar la base de datos

Crea las tablas, carga el catálogo y crea el administrador. Se ejecuta una vez y es seguro repetirlo. En el servicio de la tienda, cambia temporalmente **Settings → Deploy → Custom Start Command** por:

```bash
npm run bd:preparar && npm start
```

Cuando arranque bien, deja el comando normal (`npm start`) y borra `ADMIN_PASSWORD_INICIAL`.

## 4. Comprobar

- `https://TU-DIRECCION/api/salud` debe responder `{"estado":"ok"}`.
- Entra a `/admin.html` y abre **Automatizaciones**: los servicios deben decir "Conectado".
- Si el registro dice **"Error aplicando migraciones"**, envía ese mensaje: el código se probó con MariaDB y debe verificarse aquí con MySQL 8.

## 5. Si los correos no salen

Muchos servidores gratuitos bloquean el envío por SMTP, y entonces los correos fallan con un error de tiempo de espera en la bitácora. La solución es enviarlos por API:

1. Crea una cuenta gratuita en [brevo.com](https://www.brevo.com/en/features/email-api/) y verifica tu correo como remitente.
2. Crea una clave de API y ponla en `BREVO_API_KEY`. Tiene prioridad sobre Gmail.

## 6. Cuidados

- La contraseña de pruebas `admin123` está publicada en documentos antiguos del repositorio: el servidor **nunca** debe usarla.
- Sin volumen, las fotos de las facturas se pierden en cada publicación.
- Las tareas programadas usan la hora de Colombia, y el servidor debe quedar encendido para que salgan.
