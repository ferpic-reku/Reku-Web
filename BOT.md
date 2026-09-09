# Entrevista de prueba Reku

`/bot` recibe el motivo de consulta por texto o audio. `/bot?form=slug` y
`https://<subdominio-del-acuerdo>.reku.io/bot` resuelven el acuerdo existente
y usan su logo si tiene cobranding habilitado.

La entrevista extrae primero todo lo dicho y pregunta sólo por datos esenciales
ausentes: motivo, zona precisa, lateralidad cuando aplica, inicio, mecanismo y
dolor actual. Limitaciones, atención previa y objetivos se incorporan si la
persona los menciona, sin preguntas obligatorias adicionales. No diagnostica
ni prescribe. Ante señales de posible urgencia referidas, interrumpe la
entrevista y orienta a evaluación presencial, dejando un informe parcial.

## Configuración privada

- `OPENAI_API_KEY`: sólo en `.env`, incluido en el contenedor mediante `env_file`.
- `OPENAI_BOT_MODEL`: predeterminado `gpt-4.1-mini`.
- `OPENAI_TRANSCRIPTION_MODEL`: predeterminado `gpt-4o-mini-transcribe`.
- `OPENAI_BOT_DAILY_LIMIT`: tope global de solicitudes de IA por día, 1000.

Provisionar desde un archivo local sin imprimir la clave:

```sh
node scripts/import-openai-key.mjs .env /ruta/privada/openai.txt
```

API: `POST /api/bot/session`, `POST /api/bot/message`,
`POST /api/bot/transcribe`, `GET /api/bot/report`. La sesión usa una cookie
HttpOnly y SameSite=Strict, con validación de origen para escrituras. Texto
limitado a 4000 caracteres; grabación hasta 2 minutos; archivo hasta 8 MB.
La transcripción se muestra editable antes de enviarla. Las llamadas a OpenAI
usan HTTPS y Responses con `store: false`.

## Alcance y almacenamiento de la prueba

Sin paciente, turno ni conexión a ReHub. Conversaciones en memoria del proceso,
con expiración absoluta de 2 horas; reiniciar el servicio las pierde. Los audios
se procesan en memoria, se envían a OpenAI para transcribir y no se guardan en
Reku. Los logs no incluyen relatos ni respuestas del proveedor. El PDF se
genera desde el estado del servidor y se descarga con `no-store`.

La futura integración deberá guardar el informe en almacenamiento privado,
relacionarlo con el turno/paciente autenticados y exponerlo con autorización
profesional desde la sala de espera y la ficha del paciente. No está activa en
esta prueba y no altera el flujo de reservas existente.

Fuentes de implementación:
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://developers.openai.com/api/docs/guides/speech-to-text
- https://www.nhs.uk/symptoms/joint-pain/
