import express from "express";
import { createServer as createViteServer } from "vite";
import { Telegraf } from "telegraf";
import axios from "axios";
import Database from "better-sqlite3";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;
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
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let bot: Telegraf | null = null;

if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
  bot.start((ctx) => {
    ctx.reply(`Bot is active! Your personal Chat ID is: ${ctx.chat.id}\n\nIf you want to send messages to a CHANNEL:\n1. Add this bot to the channel as Admin.\n2. Forward a message from that channel to this bot.\n3. I will tell you the Channel's ID.`);
  });
  bot.on('message', (ctx) => {
    if (ctx.message && 'forward_from_chat' in ctx.message && ctx.message.forward_from_chat) {
      ctx.reply(`Forwarded from: ${ctx.message.forward_from_chat.title}\nID: ${ctx.message.forward_from_chat.id}\n\nUse this ID in your Secrets panel!`);
    }
  });
  bot.command('id', (ctx) => {
    ctx.reply(`This Chat ID is: ${ctx.chat.id}`);
  });
  bot.launch().catch(err => console.error("Bot launch failed:", err));
}

async function checkTransactions() {
  if (!bot || !CHAT_ID) return;

  try {
    const response = await axios.get(`https://toncenter.com/api/v2/getTransactions`, {
      params: {
        address: MASTER_WALLET,
        limit: 10,
        archival: true
      }
    });

    if (response.data.ok) {
      const transactions = response.data.result;
      for (const tx of transactions) {
        const hash = tx.transaction_id.hash;
        
        const exists = db.prepare("SELECT hash FROM transactions WHERE hash = ?").get(hash);
        if (exists) continue;

        const utime = tx.utime;
        const inMsg = tx.in_msg;
        const outMsgs = tx.out_msgs || [];

        const sendNotification = async (msg: string) => {
          try {
            await bot!.telegram.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown" });
          } catch (err: any) {
            if (err.description?.includes("chat not found")) {
              console.error(`ERROR: Chat ID "${CHAT_ID}" not found. Make sure the bot is added to the chat/channel and the ID is correct.`);
            } else {
              console.error("Failed to send telegram message:", err);
            }
          }
        };

        // Withdraw: Outgoing messages have value > 0
        for (const outMsg of outMsgs) {
          if (parseInt(outMsg.value) > 0) {
            const amount = (parseInt(outMsg.value) / 1e9).toFixed(2);
            const msg = `🐝 *Bee's Empire*\n\n✨ *Nectar Withdrawal Successful*\n\n💰 *Amount:* ${amount} TON\n🔗 *tx:Id:* \`${hash}\`\n\n[View on Tonviewer](https://tonviewer.com/transaction/${hash})`;
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

  app.get("/api/status", (req, res) => {
    res.json({
      botActive: !!BOT_TOKEN,
      chatIdSet: !!CHAT_ID,
      wallet: MASTER_WALLET,
      lastTransactions: db.prepare("SELECT * FROM transactions ORDER BY timestamp DESC LIMIT 5").all()
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
