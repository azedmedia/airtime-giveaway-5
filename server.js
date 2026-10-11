
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const LIMIT = 5;

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"]
    }
  }
}));

app.use(express.json({ limit: "3kb" }));
app.use(express.static(path.join(__dirname, "public")));

fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });

const db = new Database(
  path.join(__dirname, "data", "airtime.sqlite")
);

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    network TEXT NOT NULL
      CHECK(network IN ('MTN', 'GLO', 'AIRTEL')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

app.get("/api/status", (req, res) => {
  const count = db
    .prepare("SELECT COUNT(*) AS count FROM claims")
    .get().count;

  res.json({
    claimed: count,
    total: LIMIT,
    remaining: Math.max(0, LIMIT - count),
    full: count >= LIMIT
  });
});

async function notify(phone, network, slot) {
  const token = process.env.BOT_TOKEN;
  const chat = process.env.ADMIN_CHAT_ID;

  if (!token || !chat) {
    console.error("Telegram not configured");
    return false;
  }

  const message =
    "📱 AIRTIME GIVEAWAY — NEW CLAIM\n\n" +
    "Slot: " + slot + "/" + LIMIT + "\n" +
    "Reward: ₦100 airtime (manual top-up)\n" +
    "Network: " + network + "\n" +
    "Phone: " + phone + "\n\n" +
    "No airtime was sent automatically.";

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text: message
        })
      }
    );

    const result = await response.json();

    if (!response.ok || !result.ok) {
      console.error(
        "Telegram notification failed:",
        result.description || response.status
      );
      return false;
    }

    console.log("Telegram notification sent for slot:", slot);
    return true;
  } catch (error) {
    console.error("Telegram notification error:", error.message);
    return false;
  }
}

app.post("/api/claim", (req, res) => {
  const raw = typeof req.body?.phone === "string"
    ? req.body.phone.trim()
    : "";

  const network = typeof req.body?.network === "string"
    ? req.body.network.trim().toUpperCase()
    : "";

  const cleaned = raw.replace(/[\s()-]/g, "");

  const phone = cleaned.startsWith("+234")
    ? "0" + cleaned.slice(4)
    : cleaned.startsWith("234")
      ? "0" + cleaned.slice(3)
      : cleaned;

  if (!/^0[789][01]\d{8}$/.test(phone)) {
    return res.status(400).json({
      error: "Enter a valid Nigerian mobile number, e.g. 08012345678."
    });
  }

  if (!["MTN", "GLO", "AIRTEL"].includes(network)) {
    return res.status(400).json({
      error: "Choose MTN, Glo, or Airtel."
    });
  }

  const tx = db.transaction(() => {
    const existing = db
      .prepare("SELECT id FROM claims WHERE phone = ?")
      .get(phone);

    if (existing) {
      return { type: "duplicate" };
    }

    const count = db
      .prepare("SELECT COUNT(*) AS count FROM claims")
      .get().count;

    if (count >= LIMIT) {
      return { type: "full" };
    }

    const result = db
      .prepare("INSERT INTO claims (phone, network) VALUES (?, ?)")
      .run(phone, network);

    return {
      type: "accepted",
      slot: Number(result.lastInsertRowid)
    };
  });

  let outcome;

  try {
    outcome = tx.immediate();
  } catch (error) {
    console.error("Claim database error:", error.message);

    return res.status(500).json({
      error: "Something went wrong. Please try again."
    });
  }

  if (outcome.type === "duplicate") {
    return res.status(409).json({
      error: "This phone number has already entered. One entry per number."
    });
  }

  if (outcome.type === "full") {
    return res.status(410).json({
      error: "Airtime Fully Claimed",
      full: true
    });
  }

  notify(phone, network, outcome.slot).then(ok => {
    if (!ok) {
      console.error(
        "Claim saved but Telegram notification needs checking. Slot:",
        outcome.slot
      );
    }
  });

  const count = db
    .prepare("SELECT COUNT(*) AS count FROM claims")
    .get().count;

  return res.status(201).json({
    success: true,
    slot: outcome.slot,
    remaining: Math.max(0, LIMIT - count),
    message: "Entry received. Airtime will be topped up manually; nothing was sent automatically."
  });
});

// Express 5-compatible fallback for the website.
app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("Airtime giveaway running on port " + PORT);
});
   
