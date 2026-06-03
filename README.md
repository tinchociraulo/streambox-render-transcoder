# StreamBox Render Transcoder

Microservicio para usar con `StreamBox.html`.

Convierte streams MKV/AC3/DTS de TorBox a un MP4 compatible con navegador:

- Video: copia directa cuando se puede.
- Audio: AAC estéreo.
- Salida: MP4 fragmentado por streaming.

## Render

1. Subí esta carpeta a un repo de GitHub.
2. En Render: **New > Web Service**.
3. Elegí el repo.
4. En **Language**, seleccioná **Docker**.
5. Plan: **Free**.
6. Deploy.
7. Copiá la URL final, por ejemplo:

```text
https://streambox-transcoder.onrender.com
```

Pegala en StreamBox: **Ajustes > Render Transcoder URL**.

## Endpoints

```text
GET /health
GET /probe?url=VIDEO_URL
GET /stream?url=VIDEO_URL&audio=0&video=copy&start=0
GET /subtitle?url=VIDEO_URL&subtitle=0
```

Si `video=copy` no reproduce imagen, probá `video=h264`, pero consume mucha más CPU.

`start` permite reiniciar el stream desde un segundo exacto. StreamBox lo usa para la barra de avance precisa cuando el navegador trata la salida de ffmpeg como transmisión en vivo.
