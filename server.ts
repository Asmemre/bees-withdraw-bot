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

// ✅ Render port (kritik)
const PORT = Number(process.env.PORT || 3000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("monitor.db");

// Initialize DB
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

const MASTER_WALLET = "UQA_ThE7H_jBn3oF5jRHIztYwRUT3eYOzXwY-nFbW6AIFhJ-";

// ✅ ENV
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

// --- Health endpoints (UptimeRobot) ---
app.get("/", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.json({ status: "ok" }));

async function checkTransactions() {
  if (!bot || !CHAT_ID) return;

  try {
    const response = await axios.get(`https://toncenter.com/api/v2/getTransactions`, {
      params: {
        address: MASTER_WALLET,
        limit: 10,
        archival: true,
      },
    });

    if (response.data.ok) {
      const transactions = response.data.result;

      for (const tx of transactions) {
        const hash = tx.transaction_id.hash;

        const exists = db.prepare("SELECT hash FROM transactions WHERE hash = ?").get(hash);
        if (exists) continue;

        const utime = tx.utime;
        const outMsgs = tx.out_msgs || [];

        const sendNotification = async (msg: string) => {
          try {
            await bot!.telegram.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown" });
          } catch (err: any) {
            console.error("Failed to send telegram message:", err);
          }
        };

        // Withdraw: Outgoing messages have value > 0
        for (const outMsg of outMsgs) {
          if (parseInt(outMsg.value) > 0) {
            const amount = (parseInt(outMsg.value) / 1e9).toFixed(2);
            const msg =
              `🐝 *Bee's Empire*\n\n` +
              `✨ *Nectar Withdrawal Successful*\n\n` +
              `💰 *Amount:* ${amount} TON\n` +
              `🔗 *Tx ID:* \`${hash}\`\n\n` +
              `[View on Tonviewer](https://tonviewer.com/transaction/${hash})`;

            await sendNotification(msg);
          }
        }

        db.prepare("INSERT INTO transactions (hash, timestamp) VALUES (?, ?)").run(hash, utime);
      }
    }
  } catch (error) {
    console.error("Error checking transactions:", error);
  }
}

// Poll every 30 seconds
setInterval(checkTransactions, 30000);

async function startServer() {
  app.use(express.json());

  app.get("/api/status", (_req, res) => {
    res.json({
      botActive: !!BOT_TOKEN,
      chatIdSet: !!CHAT_ID,
      wallet: MASTER_WALLET,
      lastTransactions: db.prepare("SELECT * FROM transactions ORDER BY timestamp DESC LIMIT 5").all(),
    });
  });

  // DEV: Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // PROD: serve dist
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