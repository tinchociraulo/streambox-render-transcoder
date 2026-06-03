const http = require("http");
const { spawn } = require("child_process");
const { URL } = require("url");

const port = Number(process.env.PORT || 10000);
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 20000);

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    ...extra,
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, corsHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  }));
  res.end(JSON.stringify(payload));
}

function parseMediaUrl(value) {
  if (!value) throw new Error("Falta el parametro url");
  const mediaUrl = new URL(value);
  if (!["http:", "https:"].includes(mediaUrl.protocol)) {
    throw new Error("Solo se aceptan URLs http o https");
  }
  return mediaUrl.toString();
}

function runJsonCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} tardo demasiado`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || `${command} salio con codigo ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error("No se pudo leer la respuesta de ffprobe"));
      }
    });
  });
}

function describeTracks(probe) {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  return {
    format: probe.format || {},
    video: streams
      .map((stream, index) => ({ ...stream, streamIndex: index }))
      .filter((stream) => stream.codec_type === "video")
      .map((stream) => ({
        streamIndex: stream.streamIndex,
        codec: stream.codec_name || "",
        width: stream.width || null,
        height: stream.height || null,
        language: stream.tags?.language || "",
        title: stream.tags?.title || "",
      })),
    audio: streams
      .map((stream, index) => ({ ...stream, streamIndex: index }))
      .filter((stream) => stream.codec_type === "audio")
      .map((stream, audioIndex) => ({
        audioIndex,
        streamIndex: stream.streamIndex,
        codec: stream.codec_name || "",
        channels: stream.channels || null,
        language: stream.tags?.language || "",
        title: stream.tags?.title || "",
      })),
    subtitles: streams
      .map((stream, index) => ({ ...stream, streamIndex: index }))
      .filter((stream) => stream.codec_type === "subtitle")
      .map((stream, subtitleIndex) => ({
        subtitleIndex,
        streamIndex: stream.streamIndex,
        codec: stream.codec_name || "",
        language: stream.tags?.language || "",
        title: stream.tags?.title || "",
      })),
  };
}

async function handleProbe(reqUrl, res) {
  const mediaUrl = parseMediaUrl(reqUrl.searchParams.get("url"));
  const probe = await runJsonCommand("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    mediaUrl,
  ], requestTimeoutMs);
  sendJson(res, 200, { status: "ok", data: describeTracks(probe) });
}

function handleStream(req, reqUrl, res) {
  const mediaUrl = parseMediaUrl(reqUrl.searchParams.get("url"));
  const audioIndex = Math.max(0, Number(reqUrl.searchParams.get("audio") || 0));
  const videoMode = reqUrl.searchParams.get("video") === "h264" ? "h264" : "copy";

  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-fflags", "+genpts",
    "-i", mediaUrl,
    "-map", "0:v:0",
    "-map", `0:a:${audioIndex}?`,
  ];

  if (videoMode === "h264") {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p");
  } else {
    args.push("-c:v", "copy");
  }

  args.push(
    "-c:a", "aac",
    "-b:a", "160k",
    "-ac", "2",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1"
  );

  const ffmpeg = spawn("ffmpeg", args, { windowsHide: true });
  let stderr = "";

  res.writeHead(200, corsHeaders({
    "Content-Type": "video/mp4",
    "Cache-Control": "no-store",
    "Accept-Ranges": "none",
  }));

  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8").slice(-4000);
  });
  ffmpeg.on("error", (error) => {
    if (!res.headersSent) sendJson(res, 500, { status: "error", error: error.message });
    else res.destroy(error);
  });
  ffmpeg.on("close", (code) => {
    if (code !== 0 && !res.destroyed) {
      console.error(`ffmpeg failed with ${code}: ${stderr}`);
    }
    if (!res.destroyed) res.end();
  });

  req.on("close", () => {
    if (!ffmpeg.killed) ffmpeg.kill("SIGKILL");
  });
}

function handleSubtitle(req, reqUrl, res) {
  const mediaUrl = parseMediaUrl(reqUrl.searchParams.get("url"));
  const subtitleIndex = Math.max(0, Number(reqUrl.searchParams.get("subtitle") || 0));
  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "warning",
    "-i", mediaUrl,
    "-map", `0:s:${subtitleIndex}?`,
    "-c:s", "webvtt",
    "-f", "webvtt",
    "pipe:1",
  ], { windowsHide: true });

  let stderr = "";
  res.writeHead(200, corsHeaders({
    "Content-Type": "text/vtt; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  }));

  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8").slice(-4000);
  });
  ffmpeg.on("error", (error) => {
    if (!res.headersSent) sendJson(res, 500, { status: "error", error: error.message });
    else res.destroy(error);
  });
  ffmpeg.on("close", (code) => {
    if (code !== 0) console.error(`ffmpeg subtitle failed with ${code}: ${stderr}`);
    if (!res.destroyed) res.end();
  });

  req.on("close", () => {
    if (!ffmpeg.killed) ffmpeg.kill("SIGKILL");
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (reqUrl.pathname === "/health") {
      sendJson(res, 200, { status: "ok", service: "streambox-render-transcoder" });
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/probe") {
      await handleProbe(reqUrl, res);
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/stream") {
      handleStream(req, reqUrl, res);
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/subtitle") {
      handleSubtitle(req, reqUrl, res);
      return;
    }

    sendJson(res, 404, { status: "error", error: "Endpoint inexistente" });
  } catch (error) {
    sendJson(res, 400, { status: "error", error: error.message });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`StreamBox transcoder listening on ${port}`);
});
