const fs = require("fs");
const { Client, MessageMedia, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const commander = require("commander");
const axios = require("axios");
const urlRegex = require("url-regex");

// comandos
const STICKER_COMMANDS = new Set(["/sticker", "/s"]);

const MediaType = {
  Image: { contentType: "image/jpeg", fileName: "image.jpg" },
  Video: { contentType: "video/mp4", fileName: "video.mp4" },
};

// CLI (igual ao projeto do link)
commander
  .usage("[OPTIONS]...")
  .option("-d, --debug", "Show debug logs", false)
  .option("-c, --chrome <value>", "Use an installed Chrome/Chromium binary path")
  .option("-f, --ffmpeg <value>", "Use a different ffmpeg path")
  .parse(process.argv);

const options = commander.opts();
const logDebug = options.debug ? console.log : () => {};

function detectChromiumPath() {
  // Se o usuário passou --chrome, usa ele.
  if (options.chrome) return options.chrome;

  // Detecção comum no Ubuntu
  const candidates = ["/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  // fallback: deixa undefined (puppeteer tenta baixar/usar padrão)
  return undefined;
}

const puppeteerConfig = {
  executablePath: detectChromiumPath(),
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
};

const ffmpegPath = options.ffmpeg ? options.ffmpeg : undefined;

// Client
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "wpp-sticker" }),
  puppeteer: puppeteerConfig,
  ffmpegPath,
  // Mesma ideia do repo: fixar uma versão do WhatsApp Web via cache remoto
  webVersionCache: {
    type: "remote",
    remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
  },
});

async function sendMediaSticker(sender, type, base64Data) {
  const media = new MessageMedia(type.contentType, base64Data, type.fileName);
  await client.sendMessage(sender, media, { sendMediaAsSticker: true });
}

async function generateSticker(msg, sender) {
  // IMAGEM/VÍDEO enviados
  if (msg.type === "image") {
    const { data } = await msg.downloadMedia();
    await sendMediaSticker(sender, MediaType.Image, data);
    return;
  }

  if (msg.type === "video") {
    const { data } = await msg.downloadMedia();
    await sendMediaSticker(sender, MediaType.Video, data);
    return;
  }

  // TEXTO com link
  if (msg.type === "chat") {
    const url = msg.body
      .split(/\s+/)
      .find((t) => urlRegex({ strict: false }).test(t));

    if (!url) {
      await msg.reply("❌ Erro, URL inválida!");
      return;
    }

    logDebug("URL:", url);

    let { data, headers } = await axios.get(url, { responseType: "arraybuffer" });
    const contentType = headers["content-type"] || "";
    const base64 = Buffer.from(data).toString("base64");

    if (contentType.includes("image")) {
      await sendMediaSticker(sender, MediaType.Image, base64);
      return;
    }

    if (contentType.includes("video") || contentType.includes("gif")) {
      await sendMediaSticker(sender, MediaType.Video, base64);
      return;
    }

    await msg.reply("❌ Erro, URL inválida!");
  }
}

client.on("qr", (qr) => {
  console.log("\n📱 Escaneie o QR:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("✅ Wpp-Sticker is ready!");
});

client.on("message_create", async (msg) => {
  const first = (msg.body || "").trim().split(/\s+/)[0].toLowerCase();
  if (!STICKER_COMMANDS.has(first)) return;

  logDebug("User:", client.info.wid.user, "To:", msg.to, "From:", msg.from);

  // Mesmo truque do repo: se a msg veio do próprio número logado, responde no "to"
  const sender = msg.from.startsWith(client.info.wid.user) ? msg.to : msg.from;

  try {
    await generateSticker(msg, sender);
  } catch (e) {
    console.log(e);
    await msg.reply("❌ Erro ao gerar Sticker!");
  }
});

client.initialize(); 
