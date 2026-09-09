# Entrevista del bot Reku

## Continuidad

El servidor conserva los datos verificados de cada molestia con un identificador estable (`c1`, `c2`, etc.) y la última pregunta, su campo y su molestia. Una omisión en la extracción siguiente no borra lo ya confirmado. Las correcciones necesitan evidencia literal del mensaje actual. Las respuestas breves se interpretan contra la última pregunta, no contra el orden de las molestias que devuelva el modelo.

Una respuesta ambigua recibe como máximo una aclaración corta; si sigue sin aclararse, se registra la incertidumbre para el profesional. No se inventa una causa ni se repite indefinidamente la misma pregunta. Las sesiones continúan siendo temporales en memoria (dos horas); un reinicio requiere iniciar una conversación nueva.

Si el extractor parafrasea una cita, el único reintento interno recibe qué campos y citas fallaron. Por ejemplo, puede normalizar el motivo como «dolor», pero debe citar «me duele» si eso dijo el paciente. Las citas que sigan sin respaldo se descartan: no se relaja la exigencia de evidencia literal.

## Preguntas adicionales: máximo dos en toda la entrevista

Después de reunir los datos básicos, la IA puede proponer una pregunta sobre un vacío concreto del relato. No hay árbol fijo por patología, no se supone un diagnóstico y no es obligatorio preguntar: cero es válido. El servidor limita el total a dos, una por vez, incluso si hay varias molestias. La detección de alarma conserva prioridad y no se generan preguntas adicionales después del límite de turnos.

Generador y revisor reciben explícitamente que ninguna pregunta puede requerir una prueba, movimiento ni esfuerzo físico. Sólo puede responderse con lo que el paciente ya sabe, recuerda o notó espontáneamente, sin levantarse, examinarse ni comprobar nada, aunque parezca simple o indoloro.

Antes de mostrar cada propuesta:

1. Reglas locales verifican longitud, una sola pregunta sin consultas agrupadas, zona existente, evidencia literal del paciente y ausencia de repetición. Se rechazan solicitudes de acciones/pruebas físicas, términos sensibles y formatos fuera del conjunto descriptivo permitido.
2. Una llamada separada revisa pertinencia, utilidad, novedad, claridad, respeto, privacidad, no discriminación, ausencia de diagnóstico, seguridad y respaldo en el relato completo. Todos los criterios deben aprobarse y la confianza debe ser alta.
3. Cualquier rechazo, duda, respuesta incompleta, error o timeout omite la pregunta. No se reformula ni se reintenta una propuesta rechazada.

Las comparaciones del filtro normalizan Unicode y tildes, sin quitar las tildes del texto que ve el paciente. No usan límites de palabra ASCII después de letras acentuadas. «¿Qué actividad te cuesta hacer?» es una observación admitida, no una excepción para pedir movimientos. Pedidos como «probá», «fijate» o preguntas condicionales que requieren levantar/doblar una parte del cuerpo siguen bloqueados. Los duplicados se detectan también con diferencias de tildes, mayúsculas y puntuación.

Las preguntas adicionales tampoco vuelven a narrar el mecanismo de lesión: se ubican por la zona y preguntan lo que el paciente ya notó. Se bloquean cláusulas causales como «desde que…» o «tras…». Este control se agregó al observar que el modelo podía reformular «tirón» incorrectamente como «te tiraste».

La revisión es una barrera de reducción de riesgo, no una garantía de criterio clínico. Un ensayo adversarial mostró variabilidad del modelo ante solicitudes de pruebas físicas; por eso se agregaron bloqueos deterministas además del revisor. No debe reemplazar evaluación ni supervisión profesional.

Se conservan pregunta, molestia y respuesta textual en el resumen y el PDF. No se guarda ni muestra una hipótesis diagnóstica del generador. Las instrucciones del paciente y el contenido candidato se tratan como datos, no como órdenes del sistema. Las llamadas usan `store: false`; no se escriben conversaciones, respuestas del proveedor ni credenciales en los logs.

### Diagnóstico de omisiones

Cada decisión deja códigos controlados de etapa y motivo, duración y, en caso de rechazo del revisor, los nombres de los criterios fallidos. Se distingue omisión deliberada del generador, rechazo del filtro local, rechazo/duda del revisor, JSON inválido, timeout y error del proveedor. No se registra la pregunta candidata, evidencia, relato, excepción original ni credenciales.

Se conserva un máximo de cinco decisiones en la sesión temporal. Los logs del servidor y la consola del navegador las vinculan mediante `diagnosticId`, una referencia aleatoria independiente de la cookie y del identificador de concurrencia; no permite acceder a la sesión. Los metadatos están en la respuesta de la propia sesión, nunca en una lista pública de entrevistas. Un fallo del receptor de diagnósticos no interrumpe la entrevista.

## Modelos y pruebas

Se mantienen `OPENAI_BOT_MODEL` (por defecto `gpt-4.1-mini`) y `OPENAI_TRANSCRIPTION_MODEL` (`gpt-4o-mini-transcribe`). La revisión usa el modelo configurado en una solicitud independiente. Generador y revisor tienen 15 segundos de timeout cada uno; si fallan no impiden terminar la entrevista. La extracción principal conserva su política de error/reintento sin mutar la sesión ante fallos.

Pruebas: `node --test test/consultation-bot*.test.mjs test/bot-composer.test.mjs`, `npm run check`, `node --check bot/app.js`. Incluyen omisiones/reordenamientos, correcciones, asociación de respuestas cortas, aclaración de un «no» ambiguo, límite 0–2, prioridad de urgencia, rechazo por cada criterio de seguridad y fallos del proveedor. Los ensayos con el proveedor real usan únicamente relatos ficticios. Validar visualmente PDFs cortos y respuestas largas con paginación.

Referencias: [salidas estructuradas de OpenAI](https://developers.openai.com/api/docs/guides/structured-outputs) para el contrato JSON; [NHS: esguinces y distensiones](https://www.nhs.uk/conditions/sprains-and-strains/) para ejemplos de síntomas relatados como hinchazón, moretones y limitación funcional. Estas referencias no constituyen un protocolo diagnóstico.
