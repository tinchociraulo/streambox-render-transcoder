const http = require("http");
const { spawn } = require("child_process");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const port = Number(process.env.PORT || 10000);
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const usersFile = path.join(__dirname, "users.json");
const adminHtmlFile = path.join(__dirname, "streambox-users-admin.html");
const sessions = new Map();

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range, Authorization",
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > 1024 * 1024) {
        reject(new Error("Payload demasiado grande"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("JSON invalido"));
      }
    });
    req.on("error", reject);
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const iterations = 120000;
  const hash = crypto.pbkdf2Sync(String(password), salt, iterations, 32, "sha256").toString("hex");
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [kind, iterations, salt, hash] = String(stored || "").split("$");
  if (kind !== "pbkdf2" || !iterations || !salt || !hash) return false;
  const test = crypto.pbkdf2Sync(String(password), salt, Number(iterations), 32, "sha256");
  const expected = Buffer.from(hash, "hex");
  return expected.length === test.length && crypto.timingSafeEqual(expected, test);
}

function normalizeConfig(config = {}) {
  return {
    workerUrl: String(config.workerUrl || "").trim().replace(/\/$/, ""),
    torboxApiKey: String(config.torboxApiKey || "").trim(),
    transcoderUrl: String(config.transcoderUrl || "").trim().replace(/\/$/, ""),
  };
}

function loadUsers() {
  if (!fs.existsSync(usersFile)) return { users: [] };
  return JSON.parse(fs.readFileSync(usersFile, "utf8"));
}

function saveUsers(data) {
  fs.writeFileSync(usersFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function ensureUsersFile() {
  const data = loadUsers();
  if (data.users.length) return;
  const now = new Date().toISOString();
  data.users.push({
    id: crypto.randomUUID(),
    username: process.env.ADMIN_USERNAME || "admin",
    passwordHash: hashPassword(process.env.ADMIN_PASSWORD || "123456"),
    role: "admin",
    active: true,
    config: normalizeConfig({
      workerUrl: process.env.DEFAULT_WORKER_URL || "https://torbox-workerjs.mfciraulo.workers.dev",
      torboxApiKey: process.env.DEFAULT_TORBOX_API_KEY || "",
      transcoderUrl: process.env.DEFAULT_TRANSCODER_URL || "",
    }),
    createdAt: now,
    updatedAt: now,
  });
  saveUsers(data);
}

function publicUser(user, includeConfig = false) {
  const out = {
    id: user.id,
    username: user.username,
    role: user.role,
    active: user.active !== false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
  if (includeConfig) out.config = normalizeConfig(user.config);
  return out;
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function requireAuth(req) {
  const token = getBearerToken(req);
  const session = sessions.get(token);
  if (!token || !session) {
    const error = new Error("Sesion invalida");
    error.status = 401;
    throw error;
  }
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    const error = new Error("Sesion vencida");
    error.status = 401;
    throw error;
  }
  const data = loadUsers();
  const user = data.users.find((item) => item.id === session.userId && item.active !== false);
  if (!user) {
    const error = new Error("Usuario inactivo o inexistente");
    error.status = 401;
    throw error;
  }
  session.expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 30;
  return { token, user, data };
}

function requireAdmin(req) {
  const auth = requireAuth(req);
  if (auth.user.role !== "admin") {
    const error = new Error("Requiere administrador");
    error.status = 403;
    throw error;
  }
  return auth;
}

function assertCanRemoveAdmin(data, userId, nextUser = null) {
  const admins = data.users.filter((user) => {
    if (user.id === userId && nextUser) return nextUser.role === "admin" && nextUser.active !== false;
    if (user.id === userId && !nextUser) return false;
    return user.role === "admin" && user.active !== false;
  });
  if (!admins.length) {
    const error = new Error("Debe quedar al menos un administrador activo");
    error.status = 409;
    throw error;
  }
}

async function handleAuth(req, reqUrl, res) {
  if (req.method === "POST" && reqUrl.pathname === "/auth/login") {
    const body = await readJsonBody(req);
    const data = loadUsers();
    const user = data.users.find((item) => item.username.toLowerCase() === String(body.username || "").trim().toLowerCase());
    if (!user || user.active === false || !verifyPassword(body.password || "", user.passwordHash)) {
      sendJson(res, 401, { status: "error", error: "Usuario o contrasena incorrectos" });
      return true;
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, {
      userId: user.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30,
    });
    sendJson(res, 200, { status: "ok", token, user: publicUser(user, true) });
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/auth/logout") {
    const token = getBearerToken(req);
    if (token) sessions.delete(token);
    sendJson(res, 200, { status: "ok" });
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/auth/me") {
    const { user } = requireAuth(req);
    sendJson(res, 200, { status: "ok", user: publicUser(user, true) });
    return true;
  }

  if ((req.method === "POST" || req.method === "PUT") && reqUrl.pathname === "/auth/config") {
    const { user, data } = requireAuth(req);
    const body = await readJsonBody(req);
    user.config = normalizeConfig(body.config || body);
    user.updatedAt = new Date().toISOString();
    saveUsers(data);
    sendJson(res, 200, { status: "ok", user: publicUser(user, true) });
    return true;
  }

  return false;
}

async function handleAdminApi(req, reqUrl, res) {
  if (!reqUrl.pathname.startsWith("/admin/users")) return false;
  const { data } = requireAdmin(req);
  const parts = reqUrl.pathname.split("/").filter(Boolean);
  const userId = parts[2] || "";

  if (req.method === "GET" && !userId) {
    sendJson(res, 200, { status: "ok", users: data.users.map((user) => publicUser(user, true)) });
    return true;
  }

  if (req.method === "POST" && !userId) {
    const body = await readJsonBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (username.length < 3) throw new Error("Usuario demasiado corto");
    if (password.length < 6) throw new Error("La contrasena debe tener al menos 6 caracteres");
    if (data.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
      const error = new Error("Ese usuario ya existe");
      error.status = 409;
      throw error;
    }
    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      username,
      passwordHash: hashPassword(password),
      role: body.role === "admin" ? "admin" : "user",
      active: body.active !== false,
      config: normalizeConfig(body.config),
      createdAt: now,
      updatedAt: now,
    };
    data.users.push(user);
    saveUsers(data);
    sendJson(res, 201, { status: "ok", user: publicUser(user, true) });
    return true;
  }

  const user = data.users.find((item) => item.id === userId);
  if (!user) {
    const error = new Error("Usuario inexistente");
    error.status = 404;
    throw error;
  }

  if (req.method === "PUT") {
    const body = await readJsonBody(req);
    const nextUser = {
      ...user,
      username: String(body.username || user.username).trim(),
      role: body.role === "admin" ? "admin" : "user",
      active: body.active !== false,
      config: normalizeConfig(body.config),
      updatedAt: new Date().toISOString(),
    };
    if (body.password) {
      if (String(body.password).length < 6) throw new Error("La contrasena debe tener al menos 6 caracteres");
      nextUser.passwordHash = hashPassword(body.password);
    }
    if (data.users.some((item) => item.id !== userId && item.username.toLowerCase() === nextUser.username.toLowerCase())) {
      const error = new Error("Ese usuario ya existe");
      error.status = 409;
      throw error;
    }
    assertCanRemoveAdmin(data, userId, nextUser);
    Object.assign(user, nextUser);
    saveUsers(data);
    sendJson(res, 200, { status: "ok", user: publicUser(user, true) });
    return true;
  }

  if (req.method === "DELETE") {
    assertCanRemoveAdmin(data, userId);
    data.users = data.users.filter((item) => item.id !== userId);
    saveUsers(data);
    sendJson(res, 200, { status: "ok" });
    return true;
  }

  return false;
}

function serveFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(500, corsHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    }));
    res.end(`<!doctype html><meta charset="utf-8"><title>StreamBox</title><body style="font-family:Arial;background:#0a0a0f;color:#edf2f4;padding:32px"><h1>Falta un archivo en Render</h1><p>No se encontro <code>${path.basename(filePath)}</code>.</p><p>Subi ese archivo al repo de GitHub y espera el redeploy.</p></body>`);
    return;
  }
  res.writeHead(200, corsHeaders({
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  }));
  const stream = fs.createReadStream(filePath);
  stream.on("error", (error) => {
    if (!res.headersSent) sendJson(res, 500, { status: "error", error: error.message });
    else res.end();
  });
  stream.pipe(res);
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
    duration: Number(probe.format?.duration || 0),
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
  const start = Math.max(0, Number(reqUrl.searchParams.get("start") || 0));
  const seekMode = videoMode === "h264" ? "accurate" : "fast";

  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-fflags", "+genpts",
  ];

  if (start > 0 && seekMode === "fast") args.push("-ss", String(start));

  args.push(
    "-i", mediaUrl
  );

  if (start > 0 && seekMode === "accurate") args.push("-ss", String(start));

  args.push(
    "-map", "0:v:0",
    "-map", `0:a:${audioIndex}?`
  );

  if (videoMode === "h264") {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p");
  } else {
    args.push("-c:v", "copy");
  }

  args.push(
    "-c:a", "aac",
    "-b:a", "160k",
    "-ac", "2",
    "-af", "aresample=async=1:first_pts=0",
    "-avoid_negative_ts", "make_zero",
    "-max_interleave_delta", "0",
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
    if (req.method === "GET" && reqUrl.pathname === "/admin") {
      res.writeHead(302, corsHeaders({
        Location: "/streambox-users-admin",
        "Cache-Control": "no-store",
      }));
      res.end();
      return;
    }
    if (req.method === "GET" && reqUrl.pathname === "/streambox-users-admin") {
      serveFile(res, adminHtmlFile, "text/html; charset=utf-8");
      return;
    }
    if (await handleAuth(req, reqUrl, res)) return;
    if (await handleAdminApi(req, reqUrl, res)) return;
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

ensureUsersFile();

server.listen(port, "0.0.0.0", () => {
  console.log(`StreamBox transcoder listening on ${port}`);
});
