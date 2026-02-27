const fs = require("fs");
const path = require("path");

const { Client, MessageMedia, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const commander = require("commander");
const axios = require("axios");
const urlRegex = require("url-regex");

const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");

// ====== CONFIG ======
const STICKER_COMMANDS = new Set(["/s", "/sticker"]);
const FPS = 30;

// Duração máxima que vamos tentar (WhatsApp costuma limitar sticker animado; 10s é um bom teto)
const DURATIONS = [10, 8, 6, 5, 4, 3];

// Alvo de tamanho (não é “lei”, mas ajuda a não falhar). Pode aumentar se quiser.
const TARGET_MAX_BYTES = 1500 * 1024; // 1.5MB
// ====================

// CLI opcional
commander
  .option("-d, --debug", "Show debug logs", false)
  .option("-c, --chrome <value>", "Chrome/Chromium binary path")
  .option("-f, --ffmpeg <value>", "FFmpeg path")
  .parse(process.argv);

const options = commander.opts();
const logDebug = options.debug ? console.log : () => {};

function ensureTmp() {
  const dir = path.join(__dirname, "tmp");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  return dir;
}

function detectChromiumPath() {
  if (options.chrome) return options.chrome;

  const candidates = [
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return undefined; // Windows local geralmente não precisa
}

function detectFfmpegPath() {
  if (options.ffmpeg) return options.ffmpeg;
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  // ffmpeg-static (Windows/local) normalmente funciona
  return ffmpegStatic || undefined;
}

ffmpeg.setFfmpegPath(detectFfmpegPath());

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "wpp-sticker" }),
  puppeteer: {
    executablePath: detectChromiumPath(),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
  // ajuda conversões internas, mas nós vamos converter vídeo manualmente
  ffmpegPath: detectFfmpegPath(),
  webVersionCache: {
    type: "remote",
    remotePath:
      "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
  },
});

async function sendStickerWebp(sender, webpBuffer) {
  const media = new MessageMedia(
    "image/webp",
    webpBuffer.toString("base64"),
    "sticker.webp"
  );
  await client.sendMessage(sender, media, { sendMediaAsSticker: true });
}

async function sendImageAsSticker(sender, base64Data) {
  const media = new MessageMedia("image/jpeg", base64Data, "image.jpg");
  await client.sendMessage(sender, media, { sendMediaAsSticker: true });
}

async function videoBase64ToAnimatedWebp(videoBase64) {
  const tmp = ensureTmp();
  const inPath = path.join(tmp, `in_${Date.now()}.mp4`);
  const outPath = path.join(tmp, `out_${Date.now()}.webp`);

  fs.writeFileSync(inPath, Buffer.from(videoBase64, "base64"));

  let best = null;

  try {
    for (const duration of DURATIONS) {
      // qualidade menor = arquivo menor (em webp com ffmpeg, q:v maior => mais compressão)
      let qv = 50; // comece aqui
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise((resolve, reject) => {
          ffmpeg(inPath)
            .outputOptions([
              "-vcodec",
              "libwebp",
              "-vf",
              `scale=512:512:force_original_aspect_ratio=decrease,fps=${FPS},pad=512:512:-1:-1:color=0x00000000`,
              "-loop",
              "0",
              "-preset",
              "picture",
              "-an",
              "-vsync",
              "0",
              "-t",
              String(duration),
              "-compression_level",
              "6",
              "-q:v",
              String(qv),
            ])
            .toFormat("webp")
            .save(outPath)
            .on("end", resolve)
            .on("error", reject);
        });

        const buf = fs.readFileSync(outPath);
        best = buf;

        if (buf.length <= TARGET_MAX_BYTES) return buf;

        qv += 10; // mais compressão
      }
    }

    // se não conseguiu caber no alvo, devolve a melhor tentativa mesmo
    if (!best) throw new Error("Falha ao gerar WEBP animado.");
    return best;
  } finally {
    try {
      if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {}
  }
}

async function getTargetMessage(msg) {
  // Se o /s foi enviado respondendo uma mídia, usamos a mensagem citada
  const quoted = await msg.getQuotedMessage().catch(() => null);
  return quoted || msg;
}

function getFirstToken(text) {
  return (text || "").trim().split(/\s+/)[0].toLowerCase();
}

client.on("qr", (qr) => {
  console.log("\n📱 Escaneie o QR:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => console.log("✅ Bot conectado!"));

client.on("message_create", async (msg) => {
  try {
    const body = msg.body || "";
    const first = getFirstToken(body);

    // 1) comando no texto (/s ou /sticker)
    const isCommandText = STICKER_COMMANDS.has(first);

    // 2) comando na legenda da mídia (foto/vídeo com caption "/s")
    const caption = (msg._data?.caption || "").trim().toLowerCase();
    const isCommandCaption = STICKER_COMMANDS.has(getFirstToken(caption));

    if (!isCommandText && !isCommandCaption) return;

    // mesmo truque: se a mensagem veio do próprio número logado, responde no "to"
    const sender = msg.from.startsWith(client.info.wid.user) ? msg.to : msg.from;

    const target = isCommandText ? await getTargetMessage(msg) : msg;

    // Se o target tem mídia, baixa e processa
    if (target.hasMedia) {
      const media = await target.downloadMedia();
      if (!media) {
        await msg.reply("❌ Não consegui baixar a mídia.");
        return;
      }

      const mime = media.mimetype || "";

      // IMAGEM
      if (mime.startsWith("image/") && mime !== "image/webp") {
        await sendImageAsSticker(sender, media.data);
        return;
      }

      // VÍDEO/GIF -> converte para WEBP animado e envia
      if (mime.startsWith("video/") || mime === "image/gif") {
        const webpBuf = await videoBase64ToAnimatedWebp(media.data);
        await sendStickerWebp(sender, webpBuf);
        return;
      }

      await msg.reply("❌ Tipo de mídia não suportado. Envie imagem, vídeo ou GIF.");
      return;
    }

    // Se não tem mídia, tenta URL no texto (apenas para /s no texto)
    const url = body
      .split(/\s+/)
      .find((t) => urlRegex({ strict: false }).test(t));

    if (!url) {
      await msg.reply("❌ Use /s na legenda da mídia OU responda a mídia com /s. (Ou mande /s <url>)");
      return;
    }

    const res = await axios.get(url, { responseType: "arraybuffer" });
    const contentType = (res.headers["content-type"] || "").toLowerCase();
    const base64 = Buffer.from(res.data).toString("base64");

    if (contentType.includes("image")) {
      await sendImageAsSticker(sender, base64);
      return;
    }

    if (contentType.includes("video") || contentType.includes("gif")) {
      const webpBuf = await videoBase64ToAnimatedWebp(base64);
      await sendStickerWebp(sender, webpBuf);
      return;
    }

    await msg.reply("❌ Erro, URL inválida!");
  } catch (e) {
    console.error(e);
    try {
      await msg.reply("❌ Erro ao gerar Sticker!");
    } catch {}
  }
});

client.initialize();
