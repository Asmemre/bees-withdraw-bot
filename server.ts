import express from "express";
import { createServer as createViteServer } from "vite";
import { Telegraf } from "telegraf";
import axios from "axios";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("monitor.db");

// DB
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS transactions (
    hash TEXT PRIMARY KEY,
    timestamp INTEGER
  );
`);

const MASTER_WALLET = "UQB9K3DbZ1DJY7unriX6mU9Vk7DPu-U_s2CB0_rEF7PVYP7W";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let bot: Telegraf | null = null;

if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start((ctx) => {
    ctx.reply(
      `✅ Bees Empire Withdrawals Bot is active!\n\n` +
      `Your Chat ID: ${ctx.chat.id}\n\n` +
      `To send notifications to a CHANNEL:\n` +
      `1) Add this bot to the channel as Admin\n` +
      `2) Forward a channel message to this bot\n` +
      `3) I will show the Channel ID`
    );
  });

  bot.command("id", (ctx) => {
    ctx.reply(`This Chat ID is: ${ctx.chat.id}`);
  });

  bot.on("message", (ctx) => {
    if (ctx.message && "forward_from_chat" in ctx.message && ctx.message.forward_from_chat) {
      ctx.reply(
        `Forwarded from: ${ctx.message.forward_from_chat.title}\n` +
        `ID: ${ctx.message.forward_from_chat.id}\n\n` +
        `Use this ID as TELEGRAM_CHAT_ID in Render Env Vars.`
      );
    }
  });

  bot.launch().catch((err) => console.error("Bot launch failed:", err));
  console.log("🤖 Telegram bot launched.");
} else {
  console.log("⚠️ TELEGRAM_BOT_TOKEN is missing. Bot will NOT run.");
}

app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

function formatTon(value: string | number | undefined) {
  const raw = Number(value || 0);
  return (raw / 1e9).toFixed(2);
}

async function sendTelegramMessage(message: string) {
  if (!bot || !CHAT_ID) return;

  try {
    await bot.telegram.sendMessage(CHAT_ID, message, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error("Failed to send telegram message:", err);
  }
}

async function checkTransactions() {
  if (!bot || !CHAT_ID) return;

  try {
    const response = await axios.get("https://toncenter.com/api/v2/getTransactions", {
      params: {
        address: MASTER_WALLET,
        limit: 15,
        archival: true,
      },
    });

    if (!response.data?.ok) {
      console.error("TON API returned non-ok response:", response.data);
      return;
    }

    const transactions = response.data.result || [];

    for (const tx of transactions) {
      const hash = tx?.transaction_id?.hash;
      if (!hash) continue;

      const exists = db
        .prepare("SELECT hash FROM transactions WHERE hash = ?")
        .get(hash);

      if (exists) continue;

      const utime = tx.utime || Math.floor(Date.now() / 1000);
      const inMsg = tx.in_msg || null;
      const outMsgs = Array.isArray(tx.out_msgs) ? tx.out_msgs : [];

      // -----------------------------
      // 1) DEPOSIT BİLDİRİMİ
      // MASTER_WALLET'e gelen transfer
      // -----------------------------
      if (inMsg && Number(inMsg.value) > 0) {
        const amount = formatTon(inMsg.value);
        const fromAddress = inMsg.source || "Unknown";
        const comment =
          inMsg.message && typeof inMsg.message === "string"
            ? inMsg.message
            : null;

        let depositMsg =
          `🐝 *Bee's Empire*\n\n` +
          `📥 *New Deposit Received*\n\n` +
          `💰 *Amount:* ${amount} TON\n` +
          `👤 *From:* \`${fromAddress}\`\n` +
          `🔗 *Tx ID:* \`${hash}\`\n`;

        if (comment) {
          depositMsg += `📝 *Comment:* ${comment}\n`;
        }

        depositMsg += `\n[View on Tonviewer](https://tonviewer.com/transaction/${hash})`;

        await sendTelegramMessage(depositMsg);
      }

      // -----------------------------
      // 2) WITHDRAW BİLDİRİMİ
      // MASTER_WALLET'ten çıkan transferler
      // -----------------------------
      for (const outMsg of outMsgs) {
        if (Number(outMsg.value) > 0) {
          const amount = formatTon(outMsg.value);
          const toAddress = outMsg.destination || "Unknown";
          const comment =
            outMsg.message && typeof outMsg.message === "string"
              ? outMsg.message
              : null;

          let withdrawMsg =
            `🐝 *Bee's Empire*\n\n` +
            `📤 *Nectar Withdrawal Successful*\n\n` +
            `💰 *Amount:* ${amount} TON\n` +
            `👤 *To:* \`${toAddress}\`\n` +
            `🔗 *Tx ID:* \`${hash}\`\n`;

          if (comment) {
            withdrawMsg += `📝 *Comment:* ${comment}\n`;
          }

          withdrawMsg += `\n[View on Tonviewer](https://tonviewer.com/transaction/${hash})`;

          await sendTelegramMessage(withdrawMsg);
        }
      }

      db.prepare("INSERT INTO transactions (hash, timestamp) VALUES (?, ?)")
        .run(hash, utime);
    }
  } catch (error: any) {
    console.error("Error checking transactions:", error?.response?.data || error.message || error);
  }
}

// İlk açılışta da bir kez çalıştır
checkTransactions();

// Her 30 saniyede kontrol et
setInterval(checkTransactions, 30000);

async function startServer() {
  app.use(express.json());

  app.get("/api/status", (_req, res) => {
    res.json({
      botActive: !!BOT_TOKEN,
      chatIdSet: !!CHAT_ID,
      wallet: MASTER_WALLET,
      lastTransactions: db
        .prepare("SELECT * FROM transactions ORDER BY timestamp DESC LIMIT 10")
        .all(),
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 Server running on port ${PORT}`);
  });
}

startServer();