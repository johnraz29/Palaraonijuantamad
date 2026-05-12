const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const dbFile = process.env.DATABASE_PATH || path.join(__dirname, 'data.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error("Database Error: ", err.message);
    else console.log("Connected to database at:", dbFile);
});

function initDb() {
  db.serialize(() => {
    // 1. USERS TABLE
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,
      phone TEXT UNIQUE,
      password_hash TEXT,
      balance REAL DEFAULT 0,
      gcash_number TEXT,
      bank_account TEXT,
      name_change_count INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      is_controller INTEGER DEFAULT 0,
      is_agent INTEGER DEFAULT 0,
      referred_by INTEGER,
      referral_code TEXT UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

db.run("ALTER TABLE users ADD COLUMN is_coadmin INTEGER DEFAULT 0", (err) => {
    if (err) {
        // Okay lang kung nandyan na (Duplicate column error)
    } else {
        console.log("Column is_coadmin successfully added!");
    }
});

    // Migrations for Users (Para sa mga existing database)
    db.run("ALTER TABLE users ADD COLUMN phone TEXT", (err) => {});
    db.run("ALTER TABLE users ADD COLUMN gcash_number TEXT", (err) => {});
    db.run("ALTER TABLE users ADD COLUMN bank_account TEXT", (err) => {});
    db.run("ALTER TABLE users ADD COLUMN name_change_count INTEGER DEFAULT 0", (err) => {});
    
    // --- AGENT SYSTEM MIGRATIONS ---
    db.run("ALTER TABLE users ADD COLUMN is_agent INTEGER DEFAULT 0", (err) => {});
    db.run("ALTER TABLE users ADD COLUMN referred_by INTEGER", (err) => {});
    db.run("ALTER TABLE users ADD COLUMN referral_code TEXT", (err) => {});
    
//CUSTOMER SERVICE CHATBOX

db.run(`
CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    sender TEXT,
    message TEXT,
    created_at TEXT
)
`);

// 9. HOUSE LEDGER (Dito papasok ang kita mula sa talo ng players)
db.run(`CREATE TABLE IF NOT EXISTS house_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL,
    type TEXT,       -- 'income' (talo ng player) o 'expense' (panalo ng player/payout)
    description TEXT, -- 'Sakla Loss', 'Lotto Bet', etc.
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);


db.run(`CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount REAL,       -- REAL o NUMERIC para sa pera
    choice TEXT,
    result TEXT,
    payout REAL,       -- REAL o NUMERIC
    status TEXT,
    game_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

    // 2. BETS TABLE
    db.run(`CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      numbers TEXT,
      amount REAL,
      choice TEXT,
      game_type TEXT,
      payout REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at TEXT
    )`);

// HORSE RACE SESSIONS TABLE
db.run(`CREATE TABLE IF NOT EXISTS horse_races (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_name TEXT,           -- Halimbawa: "Race 1"
    winner_horse INTEGER,    -- Number ng nanalo (1-8)
    status TEXT DEFAULT 'open', -- 'open', 'closed', 'finished'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);



    // Migrations for Bets
    db.run("ALTER TABLE bets ADD COLUMN game_type TEXT", (err) => {});
    db.run("ALTER TABLE bets ADD COLUMN payout REAL DEFAULT 0", (err) => {});
    // Idagdag ito sa migration section ng Bets para sa Horse Race
db.run("ALTER TABLE bets ADD COLUMN race_id INTEGER", (err) => {});

    // 3. TRANSACTIONS
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      type TEXT,
      amount REAL,
      status TEXT,
      reference TEXT,
      created_at TEXT
    )`);

    // 4. RESULTS
    db.run(`CREATE TABLE IF NOT EXISTS results (
      id TEXT PRIMARY KEY,
      numbers TEXT,
      created_at TEXT
    )`);

    // 5. SETTINGS
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

// Dagdag ito para sa Coadmin support
db.run("ALTER TABLE users ADD COLUMN is_coadmin INTEGER DEFAULT 0", (err) => {
    if (err) {
        // Kung error dahil nandyan na yung column, okay lang (ignore error)
        if (!err.message.includes("duplicate column name")) {
            console.error("Error adding is_coadmin column:", err.message);
        }
    } else {
        console.log("Successfully added is_coadmin column to users table.");
    }
});

    db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('live_stream_url', 'https://www.youtube.com/embed/live_stream_id')");
    db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('video_status', 'playing')");
    db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('jackpot_prize', '100000')");

    // 6. AUTO CREATE ADMIN
    db.get('SELECT id FROM users WHERE email=?', ['admin@lotto.com'], async (err, row) => {
      if (!row) {
        const hash = await bcrypt.hash('admin123', 10);
        db.run('INSERT INTO users (name, email, phone, password_hash, is_admin) VALUES (?, ?, ?, ?, 1)',
          ['Super Admin', 'admin@lotto.com', '00000000000', hash]);
      }
    });

    // 7. AUTO CREATE CONTROLLER
    db.get('SELECT id FROM users WHERE email=?', ['controller@lotto.com'], async (err, row) => {
      if (!row) {
        const hash = await bcrypt.hash('123456', 10);
        db.run('INSERT INTO users (name, email, phone, password_hash, is_controller) VALUES (?, ?, ?, ?, 1)',
          ['Controller', 'controller@lotto.com', '11111111111', hash]);
      }
    });
  });
}


//8. sender

db.run(`
  ALTER TABLE support_messages ADD COLUMN sender_type TEXT
`, (err) => {
  if (err) {
    // Common error: column already exists
    if (!err.message.includes("duplicate column name")) {
      console.error("Error adding sender_type column:", err.message);
    }
  } else {
    console.log("sender_type column added successfully (or already exists)");
  }
});

module.exports = { initDb, db };