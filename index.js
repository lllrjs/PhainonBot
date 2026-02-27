const fs = require("fs");
const path = require("path");

const { Client, MessageMedia, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const urlRegex = require("url-regex");

const ffmpeg = require("fluent-ffmpeg");

// ===== CONFIG =====
const STICKER_COMMANDS = new Set(["/s", "/sticker"]);
const FPS = 30;
const DURATIONS = [10, 8, 6, 5, 4, 3];
const TARGET_MAX_BYTES = 1500 * 1024;
// ==================

ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

function ensureTmp() {
  const dir = path.join(__dirname, "tmp");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  return dir;
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "wpp-sticker" }),
  puppeteer: {
    executablePath: "/usr/bin/chromium-browser",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
  ffmpegPath: "/usr/bin/ffmpeg",
  webVersionCache: {
    type: "remote",
    remotePath:
      "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
  },
});

async function sendStickerWebp(sender, buffer) {
  const media = new MessageMedia(
    "image/webp",
    buffer.toString("base64"),
    "sticker.webp"
  );
  await client.sendMessage(sender, media, { sendMediaAsSticker: true });
}

async function sendImageAsSticker(sender, base64) {
  const media = new MessageMedia("image/jpeg", base64, "image.jpg");
  await client.sendMessage(sender, media, { sendMediaAsSticker: true });
}

async function videoToWebp(videoBase64) {
  const tmp = ensureTmp();
  const inPath = path.join(tmp, `in_${Date.now()}.mp4`);
  const outPath = path.join(tmp, `out_${Date.now()}.webp`);

  fs.writeFileSync(inPath, Buffer.from(videoBase64, "base64"));

  let best = null;

  try {
    for (const duration of DURATIONS) {
      let qv = 50;

      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise((resolve, reject) => {
          ffmpeg(inPath)
            .outputOptions([
              "-vcodec", "libwebp",
              "-vf", `scale=512:-1:force_original_aspect_ratio=decrease,fps=${FPS}`,
              "-loop", "0",
              "-preset", "picture",
              "-an",
              "-vsync", "0",
              "-t", String(duration),
              "-compression_level", "6",
              "-q:v", String(qv),
            ])
            .toFormat("webp")
            .save(outPath)
            .on("end", resolve)
            .on("error", reject);
        });

        const buf = fs.readFileSync(outPath);
        best = buf;

        if (buf.length <= TARGET_MAX_BYTES) return buf;

        qv += 10;
      }
    }

    if (!best) throw new Error("Falha ao gerar WEBP.");
    return best;
  } finally {
    try {
      if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {}
  }
}

async function getTargetMessage(msg) {
  const quoted = await msg.getQuotedMessage().catch(() => null);
  return quoted || msg;
}

function getCommand(text) {
  return (text || "").trim().split(/\s+/)[0].toLowerCase();
}

client.on("qr", (qr) => {
  console.log("\n📱 Escaneie o QR:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("✅ Bot conectado!");
});

client.on("message_create", async (msg) => {
  try {
    const body = msg.body || "";
    const caption = (msg._data?.caption || "").trim();
    const cmdText = getCommand(body);
    const cmdCaption = getCommand(caption);

    if (!STICKER_COMMANDS.has(cmdText) && !STICKER_COMMANDS.has(cmdCaption)) return;

    const sender = msg.from.startsWith(client.info.wid.user)
      ? msg.to
      : msg.from;

    const target = STICKER_COMMANDS.has(cmdText)
      ? await getTargetMessage(msg)
      : msg;

    if (target.hasMedia) {
      const media = await target.downloadMedia();
      if (!media) {
        await msg.reply("❌ Não consegui baixar a mídia.");
        return;
      }

      const mime = media.mimetype || "";

      if (mime.startsWith("image/") && mime !== "image/webp") {
        await sendImageAsSticker(sender, media.data);
        return;
      }

      if (mime.startsWith("video/") || mime === "image/gif") {
        const webpBuf = await videoToWebp(media.data);
        await sendStickerWebp(sender, webpBuf);
        return;
      }

      await msg.reply("❌ Tipo de mídia não suportado.");
      return;
    }

    const url = body
      .split(/\s+/)
      .find((t) => urlRegex({ strict: false }).test(t));

    if (!url) {
      await msg.reply("❌ Use /s na legenda OU responda a mídia com /s.");
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
      const webpBuf = await videoToWebp(base64);
      await sendStickerWebp(sender, webpBuf);
      return;
    }

    await msg.reply("❌ URL inválida.");
  } catch (err) {
    console.error(err);
    await msg.reply("❌ Erro ao gerar sticker.");
  }
});

client.initialize();