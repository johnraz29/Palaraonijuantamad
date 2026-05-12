require('dotenv').config();


// ==========================================
// 1. ALL CONSTANTS & DEPENDENCIES
// ==========================================
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const flash = require('connect-flash');
const bcrypt = require('bcrypt');
const { initDb, db } = require('./db');
const moment = require('moment-timezone');
const { v4: uuidv4 } = require('uuid');
const expressLayouts = require('express-ejs-layouts');
const axios = require('axios');
//SECURITY MIDDLEWARES
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');




const app = express();

const PORT = process.env.PORT || 3004;
const AGENT_COMMISSION_RATE = 0.03;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
// Admin & API Configs
const ADMIN_PANEL_PASSWORD = process.env.ADMIN_PANEL_PASSWORD;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const PAYMONGO_SECRET = process.env.PAYMONGO_SECRET;
const PAYMONGO_WEBHOOK_SECRET = process.env.PAYMONGO_WEBHOOK_SECRET;

// ==========================================
// 2. CONFIGURATIONS & MIDDLEWARES
// ==========================================



// View Engine Setup
app.set('view engine', 'ejs');
app.set('layout', 'layout');
app.set('views', __dirname + '/views');
app.set('trust proxy', 1);
// Static Files & Body Parser
app.use(express.static(__dirname + '/public'));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(helmet());

app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
}));
// Session & Flash Configuration
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24
    }
  })
);

app.use(flash()); 
app.use(passport.initialize());
app.use(passport.session());
app.use(expressLayouts);

// Global Variables for Templates
app.use((req, res, next) => {
    res.locals.user = req.user || null;
    const successMsg = req.flash('success');
    const errorMsg = req.flash('error');
    res.locals.messages = {
        success: successMsg.length > 0 ? successMsg : null,
        error: errorMsg.length > 0 ? errorMsg : null
    };
    next();
});

// Initialize Database
initDb();


app.use(express.json());

// ==========================================
// 3. PASSPORT AUTHENTICATION STRATEGY
// ==========================================

passport.use(new LocalStrategy({ usernameField: 'email' }, (email, password, done) => {
    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (err) return done(err);
        if (!user) return done(null, false, { message: 'Incorrect email.' });
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return done(null, false, { message: 'Incorrect password.' });
        return done(null, user);
    });
}));

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser((id, done) => {
    db.get('SELECT id, name, email, phone, is_admin, is_controller, is_agent, is_coadmin, referred_by, referral_code, balance, gcash_number, name_change_count FROM users WHERE id = ?', [id], (err, user) => {
        done(err, user);
    });
});

// ==========================================
// 4. HELPERS & AUTH MIDDLEWARES
// ==========================================

function manilaNow() {
    return moment().tz('Asia/Manila');
}

function ensureAuthenticated(req, res, next) {
    if (!req.isAuthenticated()) return res.redirect('/login');
    if (Number(req.user.is_controller) === 1 && req.path !== '/controller' && !req.path.startsWith('/controller/')) return res.redirect('/controller');
    return next();
}

function ensureAdmin(req, res, next) {
    if (req.isAuthenticated() && req.user && req.user.is_admin === 1 && req.user.email === ADMIN_EMAIL) {
        return next();
    }
    res.status(403).send('Forbidden: Admin access only');
}

function ensureController(req, res, next) {
    if (req.isAuthenticated() && req.user && Number(req.user.is_controller) === 1) {
        return next();
    }
    res.status(403).send('Forbidden: Controller access only');
}

function ensureAdminPanelAccess(req, res, next) {
    if (!req.session.adminVerified) return res.redirect('/admin-auth');
    next();
}

function ensureAgent(req, res, next) {
    if (req.isAuthenticated() && req.user && Number(req.user.is_agent) === 1) {
        return next();
    }
    res.status(403).send('Forbidden: Agent access only');
}

function logoutHandler(req, res) {
    req.logout(() => { 
        req.session.destroy(() => res.redirect('/')); 
    });
}

function ensureCoadmin(req, res, next) {
    if (req.isAuthenticated() && req.user && (req.user.is_coadmin === 1 || req.user.is_admin === 1)) {
        return next();
    }
    res.status(403).send('Forbidden: Coadmin access only');
}

function ensureAdminOrCoadmin(req, res, next) {
    if (
        req.isAuthenticated() &&
        req.user &&
        (req.user.is_admin === 1 || req.user.is_coadmin === 1)
    ) {
        return next();
    }

    res.status(403).send('Forbidden: Admin or Coadmin only');
}
// ==========================================
// 5. AGENT SYSTEM (Routes & Helpers)
// ==========================================

function giveAgentCommission(playerId, betAmount) {
    db.get('SELECT referred_by FROM users WHERE id = ?', [playerId], (err, user) => {
        if (err || !user || !user.referred_by) return;
        const commission = betAmount * AGENT_COMMISSION_RATE;
        db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [commission, user.referred_by]);
        db.run(`INSERT INTO transactions (id, user_id, type, amount, status, reference, created_at) VALUES (?,?,?,?,?,?,?)`,
            [uuidv4(), user.referred_by, 'commission', commission, 'confirmed', 'referral_commission', new Date().toISOString()]
        );
    });
}

app.get('/agent', ensureAgent, (req, res) => {
    const agentId = req.user.id;
    const referralLink = `${req.protocol}://${req.get('host')}/register?ref=${req.user.referral_code}`;
    const queryPlayers = `SELECT name, created_at FROM users WHERE referred_by = ?`;
    const queryStats = `SELECT (SELECT SUM(amount) FROM transactions WHERE user_id = ? AND type = 'commission') as total_earnings`;

    db.all(queryPlayers, [agentId], (err, players) => {
        db.get(queryStats, [agentId], (err2, stats) => {
            res.render('agent', { 
                user: req.user, 
                players: players || [], 
                stats: stats || { total_earnings: 0 },
                referralLink: referralLink 
            });
        });
    });
});

app.post('/agent/update-name', ensureAgent, (req, res) => {
    let { new_name } = req.body;
    if (!new_name.startsWith("Agent ")) {
        new_name = "Agent " + new_name.replace(/^Agent\s*/i, "");
    }
    db.run('UPDATE users SET name = ? WHERE id = ?', [new_name, req.user.id], (err) => {
        if (err) req.flash('error', 'Error updating name.');
        else req.flash('success', 'Agent name updated!');
        res.redirect('/agent');
    });
});

// ==========================================
// 6. AUTH & REGISTRATION ROUTES
// ==========================================

app.get('/', (req, res) => res.render('index', { user: req.user }));

app.get('/register', (req, res) => {
    const ref = req.query.ref || ''; 
    res.render('register', { ref });
});

app.post('/register', async (req, res) => {
    const { name, email, phone, password, ref_code } = req.body;
    if (!name || !email || !phone || !password) { 
        req.flash('error', 'Lahat ng fields ay kailangan.'); 
        return res.redirect('/register'); 
    }
    db.get('SELECT id FROM users WHERE email = ?', [email], async (err, emailRow) => {
        if (emailRow) { 
            req.flash('error', 'Sorry, email is already used.'); 
            return res.redirect('/register'); 
        }
        db.get('SELECT id FROM users WHERE phone = ?', [phone], async (err, phoneRow) => {
            if (phoneRow) { 
                req.flash('error', 'Sorry, phone number is already taken.'); 
                return res.redirect('/register'); 
            }
            db.get('SELECT id FROM users WHERE referral_code = ?', [ref_code], async (err, agent) => {
                const referredBy = agent ? agent.id : null;
                try {
                    const hashedPassword = await bcrypt.hash(password, 10);
                    const sql = `INSERT INTO users (name, email, phone, password_hash, balance, is_admin, is_agent, referred_by) VALUES (?, ?, ?, ?, 0, 0, 0, ?)`;
                    db.run(sql, [name, email, phone, hashedPassword, referredBy], (err) => {
                        if (err) { 
                            req.flash('error', 'Error saving user.'); 
                            return res.redirect('/register'); 
                        }
                        req.flash('success', 'Account created! Login na.');
                        res.redirect('/login');
                    });
                } catch (error) {
                    req.flash('error', 'Server error during registration.');
                    res.redirect('/register');
                }
            });
        });
    });
});

app.get('/login', (req, res) => res.render('login'));

app.post('/login', passport.authenticate('local', { failureRedirect: '/login', failureFlash: true }), (req, res) => {
    if (req.user.is_admin === 1) return res.redirect('/admin');
    if (Number(req.user.is_controller) === 1) return res.redirect('/controller');
    if (Number(req.user.is_agent) === 1) return res.redirect('/agent');
    res.redirect('/dashboard');
});

app.get('/logout', logoutHandler);
app.post('/logout', logoutHandler);

// ==========================================
// 7. USER PROFILE ROUTES
// ==========================================

app.get('/profile', ensureAuthenticated, (req, res) => {
    db.get('SELECT * FROM users WHERE id = ?', [req.user.id], (err, userRow) => {
        res.render('profile', { user: userRow }); 
    });
});

app.post('/profile/update-info', ensureAuthenticated, (req, res) => {
    const { name, email, phone } = req.body;
    db.get('SELECT name, name_change_count FROM users WHERE id = ?', [req.user.id], (err, user) => {
        if (err || !user) {
            req.flash('error', 'Database error.');
            return res.redirect('/profile');
        }
        let newCount = user.name_change_count || 0;
        let finalName = user.name;
        if (name !== user.name) {
            if (newCount >= 2) {
                req.flash('error', 'Hindi na pwedeng palitan ang pangalan. Sagad na sa 2 limits.');
                return res.redirect('/profile');
            }
            newCount++;
            finalName = name; 
        }
        db.run('UPDATE users SET name = ?, email = ?, phone = ?, name_change_count = ? WHERE id = ?', 
        [finalName, email, phone, newCount, req.user.id], (err) => {
            if (err) req.flash('error', 'Error updating profile.');
            else req.flash('success', 'Profile updated successfully!');
            res.redirect('/profile');
        });
    });
});

app.post('/profile/update-payment', ensureAuthenticated, async (req, res) => {
    const { gcash_number, current_password } = req.body;
    db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id], async (err, user) => {
        if (err || !user) { req.flash('error', 'User not found.'); return res.redirect('/profile'); }
        const match = await bcrypt.compare(current_password, user.password_hash);
        if (!match) { req.flash('error', 'Maling password.'); return res.redirect('/profile'); }
        db.run('UPDATE users SET gcash_number = ? WHERE id = ?', [gcash_number, req.user.id], (err) => {
            if (err) req.flash('error', 'Error updating payment details.');
            else req.flash('success', 'GCash number updated!');
            res.redirect('/profile');
        });
    });
});

app.post('/profile/update-password', ensureAuthenticated, async (req, res) => {
    const { current_password, new_password, confirm_password } = req.body;
    if (new_password !== confirm_password) { req.flash('error', 'Passwords do not match.'); return res.redirect('/profile'); }
    db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id], async (err, user) => {
        if (err || !user) { req.flash('error', 'User not found.'); return res.redirect('/profile'); }
        const match = await bcrypt.compare(current_password, user.password_hash);
        if (!match) { req.flash('error', 'Mali ang current password.'); return res.redirect('/profile'); }
        const hashedPassword = await bcrypt.hash(new_password, 10);
        db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashedPassword, req.user.id], (err) => {
            if (err) req.flash('error', 'Error updating password.');
            else req.flash('success', 'Password changed successfully!');
            res.redirect('/profile');
        });
    });
});

// ==========================================
// 8. GAME ROUTES (Lotto, 2D, Sabong)
// ==========================================

// Two-Digit Ball View & Bet
app.get('/twodigitball', ensureAuthenticated, (req, res) => {
    res.render('twodigitball', { user: req.user });
});

app.post('/bet/twodigit', ensureAuthenticated, (req, res) => {
    const { num1, num2, amount } = req.body;
    const betAmount = parseFloat(amount);
    const n1 = parseInt(num1);
    const n2 = parseInt(num2);

    if (n1 === n2) { req.flash('error', 'Bawal ang magkaparehong numero sa Two-Digit!'); return res.redirect('/twodigitball'); }
    if (isNaN(n1) || isNaN(n2) || n1 < 1 || n1 > 60 || n2 < 1 || n2 > 60) { req.flash('error', 'Numero dapat 1 hanggang 60 lang.'); return res.redirect('/twodigitball'); }
    if (betAmount < 10) { req.flash('error', 'Minimum na taya ay 10 pesos.'); return res.redirect('/twodigitball'); }

    db.get('SELECT balance FROM users WHERE id = ?', [req.user.id], (err, row) => {
        if (row.balance < betAmount) { req.flash('error', 'Insufficient balance!'); return res.redirect('/twodigitball'); }
        const betNumbers = `${n1},${n2}`;
        db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, req.user.id], () => {
            const jackpotAdd = betAmount * 0.02;
            db.run("UPDATE settings SET value = CAST(value AS REAL) + ? WHERE key = 'jackpot_prize'", [jackpotAdd]);
            db.run('INSERT INTO bets (user_id, numbers, amount, status, game_type, created_at) VALUES (?, ?, ?, ?, ?, ?)', 
            [req.user.id, betNumbers, betAmount, 'pending', 'twodigit', new Date().toISOString()], () => {
                req.flash('success', `Taya placed: ${n1} - ${n2}`);
                res.redirect('/dashboard');
            });
        });
    });
});

// Sabong View & Bet
app.get('/sabong', ensureAuthenticated, (req, res) => {
    db.get("SELECT value FROM settings WHERE key = 'live_stream_url'", (err, stream) => {
        db.get("SELECT value FROM settings WHERE key = 'video_status'", (err2, status) => {
            res.render('online_sabong', { 
                user: req.user, 
                streamUrl: stream ? stream.value : '',
                videoStatus: status ? status.value : 'playing'
            });
        });
    });
});

app.post('/bet/sabong', ensureAuthenticated, (req, res) => {
    const { amount, choice } = req.body; 
    const betAmount = parseFloat(amount);
    if (betAmount <= 0 || isNaN(betAmount)) return res.status(400).json({ error: 'Invalid amount' });
    db.get('SELECT balance FROM users WHERE id = ?', [req.user.id], (err, row) => {
        if (row.balance < betAmount) return res.status(400).json({ error: 'Insufficient balance' });
        db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, req.user.id], () => {
            db.run('INSERT INTO bets (user_id, amount, choice, game_type, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', 
            [req.user.id, betAmount, choice, 'sabong', 'pending', new Date().toISOString()], () => {
                res.json({ message: `Bet placed on ${choice}!`, newBalance: row.balance - betAmount });
            });
        });
    });
});

// Lotto 6/60 Bet
app.get('/bet', ensureAuthenticated, (req, res) => res.render('bet', { user: req.user }));
app.post('/bet', ensureAuthenticated, (req, res) => {

    const dow = manilaNow().day();
    if (dow === 0 || dow === 6) { 
        req.flash('error','Bets allowed Mon-Fri only'); 
        return res.redirect('/bet'); 
    }

    const numsRaw = Array.isArray(req.body.numbers) 
        ? req.body.numbers 
        : (req.body.numbers || '').split(',');

    const nums = numsRaw.map(n => parseInt(n)).filter(n => !isNaN(n));

    if (nums.length !== 6) { 
        req.flash('error','Choose 6 numbers'); 
        return res.redirect('/bet'); 
    }

    if (new Set(nums).size !== 6) { 
        req.flash('error', 'Bawal ang magkakaparehong numero!'); 
        return res.redirect('/bet'); 
    }

    const price = 10;

    db.get('SELECT balance FROM users WHERE id = ?', [req.user.id], (err, row) => {

        if (err || !row) {
            req.flash('error','Database error');
            return res.redirect('/bet');
        }

        if (row.balance < price) { 
            req.flash('error','Insufficient balance'); 
            return res.redirect('/topup'); 
        }

        db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [price, req.user.id], () => {

            // ✅ ADD 2% SA JACKPOT
            const jackpotAdd = price * 0.02;

            db.run(
                "UPDATE settings SET value = CAST(value AS REAL) + ? WHERE key = 'jackpot_prize'", 
                [jackpotAdd]
            );

            db.run(
                'INSERT INTO bets (user_id,numbers,amount,status,game_type,created_at) VALUES (?,?,?,?,?,?)', 
                [req.user.id, nums.join(','), price, 'pending', 'lotto', new Date().toISOString()], 
                () => {
                    req.flash('success','Bet placed!');
                    res.redirect('/dashboard');
                }
            );

        });

    });

});


// SLOT MACHINE LOGIC & ADMIN SETTINGS

// Route para sa Slot Machine View
app.get('/slot-machine', ensureAuthenticated, (req, res) => {
    db.get("SELECT value FROM settings WHERE key = 'slot_win_rate'", (err, row) => {
        const winRate = row ? row.value : 50; // Default 50%
        res.render('slot_machine', { user: req.user, winRate });
    });
});

// Slot Machine Bet Logic
app.post('/slot/spin', ensureAuthenticated, (req, res) => {
    const { amount } = req.body;
    const betAmount = parseFloat(amount);

    if (isNaN(betAmount) || betAmount < 1) return res.status(400).json({ error: 'Invalid bet amount' });

    db.get('SELECT balance FROM users WHERE id = ?', [req.user.id], (err, user) => {
        if (!user || user.balance < betAmount) return res.status(400).json({ error: 'Insufficient balance' });

        // Kunin ang Win Rate mula sa settings
        db.get("SELECT value FROM settings WHERE key = 'slot_win_rate'", (err2, setting) => {
            const winRate = setting ? parseInt(setting.value) : 30; 
            const chance = Math.floor(Math.random() * 100) + 1;
            const isWinner = chance <= winRate;

            // Bawasan ang balance ng player (Taya)
            db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, req.user.id], (updErr) => {
                if (updErr) return res.status(500).json({ error: 'Database error' });

                if (isWinner) {
                    const prize = betAmount * 2; 
                    db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [prize, req.user.id]);
                    
                    // ALISIN ANG uuidv4() SA UNANG COLUMN DAHIL AUTOINCREMENT ANG ID SA DB.JS MO
                    db.run('INSERT INTO bets (user_id, amount, status, game_type, payout, created_at) VALUES (?,?,?,?,?,?)',
                        [req.user.id, betAmount, 'won', 'slot', prize, new Date().toISOString()]);
                    
                    res.json({ result: 'win', payout: prize, message: `Panalo ka ng ₱${prize}!` });
                } else {
                    // ALISIN ANG uuidv4() DITO RIN
                    db.run('INSERT INTO bets (user_id, amount, status, game_type, payout, created_at) VALUES (?,?,?,?,?,?)',
                        [req.user.id, betAmount, 'lost', 'slot', 0, new Date().toISOString()]);
                    
                    if (typeof giveAgentCommission === "function") {
                        giveAgentCommission(req.user.id, betAmount);
                    }
                    
                    res.json({ result: 'lost', message: 'Sawi! Subok ulit.' });
                }
            });
        });
    });
});

// Admin Route para baguhin ang Win Rate
app.post('/admin/slot/settings', ensureAdmin, (req, res) => {
    const { win_rate } = req.body;
    
    // Gamitin ang INSERT OR REPLACE para kung wala pa yung 'slot_win_rate', gagawa siya ng bago.
    // Kung meron na, papalitan (update) niya ang value nito.
    const sql = `INSERT OR REPLACE INTO settings (key, value) VALUES ('slot_win_rate', ?)`;

    db.run(sql, [win_rate], (err) => {
        if (err) {
            console.error(err.message);
            req.flash('error', 'Failed to update win rate.');
        } else {
            req.flash('success', `Slot Win Rate updated to ${win_rate}%`);
        }
        res.redirect('/admin/slot-config');
    });
});

// View for Admin Slot Config
app.get('/admin/slot-config', ensureAdmin, ensureAdminPanelAccess, (req, res) => {
    db.get("SELECT value FROM settings WHERE key = 'slot_win_rate'", (err, row) => {
        res.render('admin_slot_config', { user: req.user, currentRate: row ? row.value : 30 });
    });
});


// ==========================================
// 9. FINANCIAL ROUTES (Topup, Withdraw, PayMongo)
// ==========================================

app.post('/paymongo/gcash', ensureAuthenticated, async (req, res) => {
    const { amount } = req.body;

    const parsedAmount = Number(amount);

    if (!parsedAmount || parsedAmount <= 0) {
        req.flash('error', 'Invalid amount');
        return res.redirect('/topup');
    }

    const txRef = uuidv4();
    const amountInCentavos = Math.round(parsedAmount * 100);

    try {
        const response = await axios.post(
            'https://api.paymongo.com/v1/checkout_sessions',
            {
                data: {
                    attributes: {
                        billing: {
                            name: req.user.name,
                            email: req.user.email,
                            phone: req.user.phone
    ? req.user.phone.replace(/^0/, '+63')
    : '+639123456789'
                        },
                        send_email_receipt: false,
                        show_description: true,
                        show_line_items: true,

                        line_items: [
                            {
                                currency: 'PHP',
                                amount: amountInCentavos,
                                name: 'Top-up Balance',
                                quantity: 1
                            }
                        ],

                        payment_method_types: ['gcash'],

                        success_url: `${BASE_URL}/pay-success`,
cancel_url: `${BASE_URL}/pay-failed`,

                        metadata: {
                            txRef: txRef
                        }
                    }
                }
            },
            {
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                    authorization: `Basic ${Buffer.from(PAYMONGO_SECRET + ':').toString('base64')}`
                }
            }
        );

        const checkoutUrl = response.data.data.attributes.checkout_url;

        // save transaction
        db.run(
            'INSERT INTO transactions (id, user_id, type, amount, status, reference, created_at) VALUES (?,?,?,?,?,?,?)',
            [
                txRef,
                req.user.id,
                'topup',
                parsedAmount,
                'pending_gcash',
                txRef,
                new Date().toISOString()
            ]
        );

        res.redirect(checkoutUrl);

    } catch (error) {
        console.log("PAYMONGO CHECKOUT ERROR:");
        console.log(error.response?.data);
        console.log(error.message);

        req.flash('error', 'Payment gateway error.');
        res.redirect('/topup');
    }
});

app.get('/pay-success', (req, res) => { req.flash('success', 'Payment request processed.'); res.redirect('/dashboard'); });
app.get('/pay-failed', (req, res) => { req.flash('error', 'Payment failed.'); res.redirect('/topup'); });

app.get('/topup', ensureAuthenticated, (req, res) => res.render('topup', { user: req.user }));
app.post('/topup', ensureAuthenticated, (req, res) => {
    const { amount, reference } = req.body;
    if (!amount || amount <= 0) { req.flash('error','Invalid amount'); return res.redirect('/topup'); }
    db.run('INSERT INTO transactions (id,user_id,type,amount,status,reference,created_at) VALUES (?,?,?,?,?,?,?)', 
    [uuidv4(), req.user.id, 'topup', amount, 'pending', reference || '', new Date().toISOString()], () => {
        req.flash('success','Top-up request created.');
        res.redirect('/dashboard');
    });
});

app.get('/withdraw', ensureAuthenticated, (req, res) => res.render('withdraw', { user: req.user }));
app.post('/withdraw', ensureAuthenticated, (req, res) => {
    const { amount } = req.body;
    const a = parseFloat(amount);
    if (!a || a <= 0) { req.flash('error', 'Invalid amount'); return res.redirect('/withdraw'); }
    if (a < 100) { req.flash('error', 'Ang minimum withdrawal ay 100 pesos.'); return res.redirect('/withdraw'); }

    db.get('SELECT balance, gcash_number FROM users WHERE id = ?', [req.user.id], (err, user) => {
        if (!user.gcash_number) { req.flash('error', 'Set GCash number in Profile.'); return res.redirect('/profile'); }
        if (user.balance < a) { req.flash('error', 'Insufficient balance'); return res.redirect('/withdraw'); }

        db.run('INSERT INTO transactions (id,user_id,type,amount,status,reference,created_at) VALUES (?,?,?,?,?,?,?)', 
        [uuidv4(), req.user.id, 'withdraw', a, 'pending', user.gcash_number, new Date().toISOString()], () => {
            db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [a, req.user.id], () => {
                req.flash('success', 'Withdraw request created.');
                res.redirect('/dashboard');
            });
        });
    });
});

// ==========================================
// PAYMONGO WEBHOOK (AUTO CREDIT TOPUP)
// ==========================================
app.post('/paymongo/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
    try {
        const event = req.body;

        console.log("WEBHOOK:", JSON.stringify(event, null, 2));

        if (event.data.type !== 'payment.paid') {
            return res.sendStatus(200);
        }

        const payment = event.data.attributes;

        const amount = payment.amount / 100;

        const reference = payment.metadata?.txRef;

        console.log("TX REF:", reference);

        db.get(
            `SELECT * FROM transactions 
             WHERE id = ? AND status = 'pending_gcash'`,
            [reference],
            (err, tx) => {

                if (!tx) {
                    console.log("❌ No transaction found:", reference);
                    return res.sendStatus(200);
                }

                console.log("✅ Crediting:", tx.user_id);

                db.run(
                    'UPDATE users SET balance = balance + ? WHERE id = ?',
                    [amount, tx.user_id]
                );

                db.run(
                    'UPDATE transactions SET status = ? WHERE id = ?',
                    ['confirmed', tx.id]
                );
            }
        );

        res.sendStatus(200);

    } catch (err) {
        console.log("WEBHOOK ERROR:", err);
        res.sendStatus(500);
    }
});

// ==========================================
// 10. DASHBOARD & STATS
// ==========================================

app.get('/dashboard', ensureAuthenticated, (req, res) => {

    db.all(
        'SELECT * FROM bets WHERE user_id = ? ORDER BY created_at DESC',
        [req.user.id],
        (err, bets) => {

            db.all(
                'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC',
                [req.user.id],
                (err2, txs) => {

                    db.get(
                        "SELECT value FROM settings WHERE key = 'jackpot_prize'",
                        (err0, row) => {

                            let jackpot = row ? parseFloat(row.value) : 100000;

                            db.all(
                                'SELECT amount FROM bets WHERE game_type = "lotto" AND status = "pending"',
                                [],
                                (err3, allBets) => {

                                    if (allBets) {
                                        allBets.forEach(b => {
                                            jackpot += b.amount * 0.02;
                                        });
                                    }

                                    db.get(`
                                        SELECT numbers 
                                        FROM results
                                        WHERE (length(numbers) - length(replace(numbers, ",", "")) + 1) = 6
                                        ORDER BY created_at DESC
                                        LIMIT 1
                                    `, [], (err4, lottoRes) => {

                                        db.get(`
                                            SELECT numbers 
                                            FROM results
                                            WHERE (length(numbers) - length(replace(numbers, ",", "")) + 1) = 2
                                            ORDER BY created_at DESC
                                            LIMIT 1
                                        `, [], (err5, twoDigitRes) => {

                                            let userWon = false;

                                            if (bets && lottoRes && lottoRes.numbers) {

                                                const rnums = lottoRes.numbers
                                                    .split(',')
                                                    .map(Number)
                                                    .sort((a, b) => a - b);

                                                bets.forEach(b => {

                                                    if (
                                                        b.numbers &&
                                                        b.game_type === 'lotto' &&
                                                        b.status === 'won'
                                                    ) {

                                                        const bnums = b.numbers
                                                            .split(',')
                                                            .map(Number)
                                                            .sort((a, b) => a - b);

                                                        if (
                                                            JSON.stringify(bnums) === JSON.stringify(rnums)
                                                        ) {
                                                            userWon = true;
                                                        }
                                                    }
                                                });
                                            }

                                            res.render('dashboard', {
                                                user: req.user,
                                                bets,
                                                txs,
                                                jackpot,
                                                lottoResult: lottoRes?.numbers || "No result yet",
                                                twoDigitResult: twoDigitRes?.numbers || "No result yet",
                                                userWon
                                            });

                                        });
                                    });
                                });
                        });
                });
        });

});



// ==========================================
// 10.5 ONLINE SAKLA ROUTES
// ==========================================

app.get('/sakla', ensureAuthenticated, (req, res) => {
    res.render('sakla', { user: req.user });
});

app.post('/sakla/bet', ensureAuthenticated, (req, res) => {
    const { amount, choice } = req.body; 
    const betAmount = parseFloat(amount);

    if (isNaN(betAmount) || betAmount < 5) {
        return res.status(400).json({ error: 'Minimum bet is ₱5.' });
    }

    db.get('SELECT balance FROM users WHERE id = ?', [req.user.id], (err, user) => {
        if (!user || user.balance < betAmount) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        // Bawasan ang balance ng player
        db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, req.user.id], (updErr) => {
            if (updErr) return res.status(500).json({ error: 'Database error' });

            // SAKLA LOGIC: 5 Cards (Alas, Tres, Sota, Kabayo, Hari)
            const cards = ['Alas', 'Tres', 'Sota', 'Kabayo', 'Hari'];
            const winningCard = cards[Math.floor(Math.random() * cards.length)];
            const isWinner = (choice === winningCard);

            if (isWinner) {
                // Panalo: 4x ang payout (300% profit + original bet)
                const prize = betAmount * 2;

                db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [prize, req.user.id]);
                
                db.run(
    'INSERT INTO bets (user_id, amount, status, game_type, choice, numbers, payout, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [req.user.id, betAmount, 'won', 'sakla', choice, winningCard, prize, new Date().toISOString()]
);
                res.json({ result: 'win', winningCard, payout: prize });
            } else {
                // Talo: Record ang bet
               db.run(
    'INSERT INTO bets (user_id, amount, status, game_type, choice, numbers, payout, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [req.user.id, betAmount, 'lost', 'sakla', choice, winningCard, 0, new Date().toISOString()]
);
                // ✅ AGENT COMMISSION (Sinunod ko ang logic mo sa Sabong/Lotto)
                // Sa code mo, tinatawag mo ang giveAgentCommission(user_id, amount)
                giveAgentCommission(req.user.id, betAmount);

                res.json({ result: 'lost', winningCard });
            }
        });
    });
});


// ==========================================
// 10.6 ONLINE HORSE RACE ROUTES
// ==========================================

app.get('/onlinehorserace', ensureAuthenticated, (req, res) => {
    res.render('onlinehorserace', { user: req.user });
});

app.post('/bet/horserace', ensureAuthenticated, (req, res) => {
    const { choice, amount } = req.body;
    const betAmount = parseFloat(amount);
    const userChoice = parseInt(choice);

    // Sinunod ang logic mo na kailangang valid ang amount
    if (isNaN(betAmount) || betAmount < 10) {
        return res.status(400).json({ error: 'Minimum bet is ₱10.' });
    }

    db.get('SELECT balance FROM users WHERE id = ?', [req.user.id], (err, user) => {
        if (!user || user.balance < betAmount) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        // Bawasan ang balance
        db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, req.user.id], (updErr) => {
            if (updErr) return res.status(500).json({ error: 'Database error' });

            // Horse Race Logic: 4 Horses
            const winningHorse = Math.floor(Math.random() * 4) + 1;
            const isWinner = (userChoice === winningHorse);

            if (isWinner) {
                // Payout: 1:1 ratio (Taya + Panalo = 2x ng bet)
                const prize = betAmount * 2;
                db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [prize, req.user.id]);
                
                db.run(
                    'INSERT INTO bets (user_id, amount, status, game_type, choice, numbers, payout, created_at) VALUES (?,?,?,?,?,?,?,?)',
                    [req.user.id, betAmount, 'won', 'horserace', userChoice, winningHorse.toString(), prize, new Date().toISOString()]
                );
                res.json({ 
    result: 'win', 
    winningHorse, 
    payout: prize,
    message: '🎉 You Win!'
});
            } else {
                db.run(
                    'INSERT INTO bets (user_id, amount, status, game_type, choice, numbers, payout, created_at) VALUES (?,?,?,?,?,?,?,?)',
                    [req.user.id, betAmount, 'lost', 'horserace', userChoice, winningHorse.toString(), 0, new Date().toISOString()]
                );
                
                // ✅ AGENT COMMISSION (Sakop ang system mo)
                giveAgentCommission(req.user.id, betAmount);

                res.json({ 
    result: 'lost', 
    winningHorse,
    message: '❌ You Lose! Try Again.'
});
            }
        });
    });
});




// ==========================================
// 11. CONTROLLER ROUTES (Results Management)
// ==========================================

app.get('/controller', ensureController, (req, res) => {
    db.all('SELECT * FROM bets ORDER BY created_at DESC', [], (err, bets) => {
        db.get("SELECT value FROM settings WHERE key = 'live_stream_url'", (err2, stream) => {
            res.render('controller', {
                user: req.user,
                bets: bets || [],
                streamUrl: stream ? stream.value : ''
            });
        });
    });
});

app.post('/controller/sabong-result', ensureController, (req, res) => {
    const winner = (req.body.winner || '').toUpperCase();
    if (!['MERON', 'WALA'].includes(winner)) return res.redirect('/controller');
    db.all("SELECT * FROM bets WHERE game_type = 'sabong' AND status = 'pending'", [], (err, allBets) => {
        if (!allBets || allBets.length === 0) return res.redirect('/controller');
        const totalPool = allBets.reduce((sum, b) => sum + b.amount, 0);
        const winners = allBets.filter(b => b.choice.toUpperCase() === winner);
        const distributable = totalPool * 0.80;
        if (winners.length > 0) {
            const totalWinnerBet = winners.reduce((sum, b) => sum + b.amount, 0);
            winners.forEach(bet => {
                const payout = (bet.amount / totalWinnerBet) * distributable;
                db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [payout, bet.user_id]);
                db.run('UPDATE bets SET status = "won", payout = ? WHERE id = ?', [payout, bet.id]);
                db.run('INSERT INTO transactions (id,user_id,type,amount,status,reference,created_at) VALUES (?,?,?,?,?,?,?)',
                    [uuidv4(), bet.user_id, 'payout', payout, 'confirmed', 'sabong_win', new Date().toISOString()]
                );
            });
        }
        db.all(`
SELECT * FROM bets 
WHERE game_type='sabong'
AND status='pending'
AND choice != ?
`, [winner], (err, losers) => {

    losers.forEach(bet => {
        db.run('UPDATE bets SET status="lost" WHERE id=?', [bet.id]);

        // commission sa natalo
        giveAgentCommission(bet.user_id, bet.amount);
    });

});
        db.run("INSERT INTO results (id,numbers,created_at) VALUES (?,?,?)", [uuidv4(), winner, new Date().toISOString()]);
        res.redirect('/controller');
    });
});

app.post('/controller/draw-result', ensureController, (req, res) => {
    let { numbers, game_type, num1, num2 } = req.body; 
    let finalNumbers = "";
    let inputNums = [];

    if (game_type === 'twodigit') {
        inputNums = (num1 && num2) ? [parseInt(num1), parseInt(num2)] : (numbers || '').split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
        if (inputNums.length !== 2) { req.flash('error', 'Kailangan ng 2 numero.'); return res.redirect('/controller'); }
        if (inputNums[0] === inputNums[1]) { req.flash('error', 'Bawal magkapareho.'); return res.redirect('/controller'); }
        finalNumbers = inputNums.join(','); 
    } 
    else if (game_type === 'lotto') {
        inputNums = (numbers || '').split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
        if (inputNums.length !== 6) { req.flash('error', 'Kailangan ng 6 na numero.'); return res.redirect('/controller'); }
        if (new Set(inputNums).size !== 6) { req.flash('error', 'Bawal magkapareho.'); return res.redirect('/controller'); }
        finalNumbers = inputNums.join(',');
    } else { return res.redirect('/controller'); }

    const resultId = uuidv4();
    db.all('SELECT amount FROM bets WHERE game_type = "lotto" AND status = "pending"', [], (err, allPending) => {
        let currentJackpot = 100000;
        if(allPending) allPending.forEach(b => currentJackpot += b.amount * 0.02);

        db.run('INSERT INTO results (id, numbers, created_at) VALUES (?, ?, ?)', [resultId, finalNumbers, new Date().toISOString()], () => {
            db.all("SELECT * FROM bets WHERE status = 'pending' AND game_type = ?", [game_type], (err, bets) => {
                if (!bets) return res.redirect('/controller');
                bets.forEach(b => {
                    let isWinner = false;
                    let prize = 0;
                    if (b.game_type === 'lotto') {
                        const userBetSorted = b.numbers.split(',').map(Number).sort((a, b) => a - b).join(',');
                        const resultSorted = inputNums.slice().sort((a, b) => a - b).join(',');
                        if (userBetSorted === resultSorted) { isWinner = true; prize = currentJackpot; }
                    } else if (b.game_type === 'twodigit') {
                        if (b.numbers === finalNumbers) { isWinner = true; prize = b.amount * 50; }
                    }

                    if (isWinner) {
    db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [prize, b.user_id]);
    db.run('UPDATE bets SET status = "won", payout = ? WHERE id = ?', [prize, b.id]);

    db.run(`
        INSERT INTO transactions 
        (id, user_id, type, amount, status, reference, created_at) 
        VALUES (?,?,?,?,?,?,?)
    `,
    [
        uuidv4(),
        b.user_id,
        'payout',
        prize,
        'confirmed',
        `${b.game_type}_win`,
        new Date().toISOString()
    ]);

} else {

    db.run('UPDATE bets SET status = "lost" WHERE id = ?', [b.id]);

    // ✅ AGENT COMMISSION PAG NATALO LANG
    giveAgentCommission(b.user_id, b.amount);
}
                });
                req.flash('success', `Result ${finalNumbers} published!`);
                res.redirect('/controller');
            });
        });
    });
});

// Coadmin Dashboard - Listahan ng Withdrawal Requests
app.get('/coadmin', ensureCoadmin, (req, res) => {
    // Kukunin lang ang withdrawal transactions na pending
    db.all("SELECT transactions.*, users.name as user_name FROM transactions JOIN users ON transactions.user_id = users.id WHERE transactions.type = 'withdraw' AND transactions.status = 'pending' ORDER BY transactions.created_at DESC", [], (err, rows) => {
        res.render('coadmin', { user: req.user, withdrawals: rows || [] });
    });
});

// Route para sa pag-approve ng withdrawal (Coadmin Action)
app.post('/coadmin/withdraw/approve', ensureCoadmin, (req, res) => {
    const { id } = req.body;
    db.run("UPDATE transactions SET status = 'paid' WHERE id = ?", [id], (err) => {
        if (err) req.flash('error', 'Error approving withdrawal.');
        else req.flash('success', 'Withdrawal marked as paid!');
        res.redirect('/coadmin');
    });
});




// ==========================================
// 12. ADMIN ROUTES
// ==========================================

app.get('/admin-auth', (req, res) => res.render('admin_auth'));
app.post('/admin-auth', ensureAuthenticated, (req, res) => {
    if (req.body.admin_password !== ADMIN_PANEL_PASSWORD) { req.flash('error', 'Incorrect password'); return res.redirect('/admin-auth'); }
    req.session.adminVerified = true;
    res.redirect('/admin');
});

app.get('/admin', ensureAdmin, ensureAdminPanelAccess, (req, res) => {
    db.all('SELECT * FROM users', [], (err3, users) => {
        db.all('SELECT * FROM bets ORDER BY created_at DESC', [], (err, bets) => {
            db.all('SELECT * FROM transactions ORDER BY created_at DESC', [], (err2, txs) => {
                const totalBetsAmount = bets ? bets.reduce((sum, b) => sum + (b.amount || 0), 0) : 0;
                const totalPayouts = txs ? txs.filter(t => t.type === 'payout' || (t.type === 'withdraw' && t.status === 'paid')).reduce((sum, t) => sum + (t.amount || 0), 0) : 0;
                const houseEarnings = totalBetsAmount - totalPayouts;
                req.sessionStore.all((err, sessions) => {
                    let onlineCount = (sessions) ? Object.values(sessions).filter(s => s.passport && s.passport.user).length : 0;
                  db.get("SELECT value FROM settings WHERE key = 'slot_win_rate'", (err, setting) => {
                        const currentSlotRate = setting ? setting.value : 30;

                        res.render('admin', { 
                            user: req.user, 
                            bets: bets || [], 
                            txs: txs || [], 
                            users: users || [], 
                            houseEarnings, 
                            totalBetsAmount, 
                            onlinePlayers: onlineCount,
                            currentSlotRate: currentSlotRate // Ipapasa ito sa admin.ejs
                        });
                    });
                });
            });
        });
    });
});

app.post('/admin/user/update', ensureAdmin, async (req, res) => {
    const { id, name, email, phone, gcash_number, new_password } = req.body;
    try {
        if (new_password && new_password.trim() !== "") {
            const hashedPassword = await bcrypt.hash(new_password, 10);
            db.run('UPDATE users SET name = ?, email = ?, phone = ?, gcash_number = ?, password_hash = ? WHERE id = ?',
                [name, email, phone, gcash_number, hashedPassword, id], (err) => {
                    if (err) req.flash('error', 'Error updating user.');
                    else req.flash('success', 'User updated successfully!');
                    res.redirect('/admin');
                });
        } else {
            db.run('UPDATE users SET name = ?, email = ?, phone = ?, gcash_number = ? WHERE id = ?',
                [name, email, phone, gcash_number, id], (err) => {
                    if (err) req.flash('error', 'Error updating user.');
                    else req.flash('success', 'User updated successfully!');
                    res.redirect('/admin');
                });
        }
    } catch (error) { req.flash('error', 'Server error.'); res.redirect('/admin'); }
});

app.post('/admin/tx/confirm', ensureAdmin, (req,res)=>{
    db.get('SELECT * FROM transactions WHERE id = ?', [req.body.id], (err, tx)=>{
        if (tx && tx.status === 'pending') {
            db.run('UPDATE transactions SET status = ? WHERE id = ?', ['confirmed', tx.id], () => {
                db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [tx.amount, tx.user_id], () => {
                    req.flash('success','Topup confirmed');
                    res.redirect('/admin');
                });
            });
        }
    });
});

app.post('/admin/tx/complete', ensureAdmin, (req,res)=>{
    db.run('UPDATE transactions SET status = ? WHERE id = ?', ['paid', req.body.id], () => {
        req.flash('success','Withdraw marked as paid');
        res.redirect('/admin');
    });
});

app.post('/admin/video/update', ensureAdmin, (req, res) => {
    let { url, status } = req.body;
    if (url.includes('watch?v=')) url = url.replace('watch?v=', 'embed/');
    else if (url.includes('youtu.be/')) url = url.replace('youtu.be/', 'www.youtube.com/embed/');
    url += "?controls=0&disablekb=1&rel=0&autoplay=1&modestbranding=1&iv_load_policy=3";
    db.run("UPDATE settings SET value = ? WHERE key = 'live_stream_url'", [url], () => {
        db.run("UPDATE settings SET value = ? WHERE key = 'video_status'", [status], () => {
            res.redirect('/admin');
        });
    });
});

// HOUSE LEDGER - Detailed Earnings Report

app.get('/admin/house-ledger', ensureAdmin, ensureAdminPanelAccess, (req, res) => {
    db.all("SELECT * FROM bets", [], (err, allBets) => {
        if (err) return res.redirect('/admin');
        
        const sBets = allBets.filter(b => b.game_type === 'sabong');

const dBets = allBets.filter(
    b => b.game_type === 'lotto' || b.game_type === 'twodigit'
);

const saklaBets = allBets.filter(
    b => b.game_type === 'sakla'
);

const slotBets = allBets.filter(
    b => b.game_type === 'slot'
);
const horseBets = allBets.filter(b => b.game_type === 'horserace');

        let totalSabongVolume = sBets.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
        let sabongEarnings = totalSabongVolume * 0.20; 

        let totalDrawVolume = dBets.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
        let totalDrawPayouts = dBets.filter(b => b.status === 'won').reduce((sum, b) => sum + (Number(b.payout) || 0), 0);
        let drawEarnings = totalDrawVolume - totalDrawPayouts;
// SLOT EARNINGS
let totalSlotVolume = slotBets.reduce(
    (sum, b) => sum + (Number(b.amount) || 0),
    0
);

let totalSlotPayouts = slotBets
    .filter(b => b.status === 'won')
    .reduce(
        (sum, b) => sum + (Number(b.payout) || 0),
        0
    );

let slotEarnings = totalSlotVolume - totalSlotPayouts;
        // SAKLA EARNINGS calculation
        let totalSaklaVolume = saklaBets.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
        let totalSaklaPayouts = saklaBets.filter(b => b.status === 'won').reduce((sum, b) => sum + (Number(b.payout) || 0), 0);
        let saklaEarnings = totalSaklaVolume - totalSaklaPayouts;

// HORSE RACE EARNINGS (Idagdag ito)
let totalHorseVolume = horseBets.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
let totalHorsePayouts = horseBets.filter(b => b.status === 'won').reduce((sum, b) => sum + (Number(b.payout) || 0), 0);
let horseEarnings = totalHorseVolume - totalHorsePayouts;

        let totalHouseEarnings =
    sabongEarnings +
    drawEarnings +
    saklaEarnings +
    slotEarnings +
    horseEarnings;

        res.render('houseledger', { 
    user: req.user, 
    sabongBets: sBets, 
    drawBets: dBets,
    saklaBets: saklaBets,
    slotBets: slotBets,
    horseBets: horseBets,

    sabongEarnings, 
    drawEarnings, 
    saklaEarnings,
    slotEarnings,
    horseEarnings,

    totalHouseEarnings,

    totalSabongVolume, 
    totalDrawPayouts,
    totalSlotPayouts,
    totalHorseVolume,
});
    });
});


// Gawing Agent ang Player
app.post('/admin/make-agent', ensureAdmin, (req, res) => {
    const userId = req.body.user_id;
    const referralCode = Math.random().toString(36).substring(2, 8).toUpperCase(); // Gagawa ng random code

    const sql = `UPDATE users SET is_agent = 1, referral_code = ? WHERE id = ?`;
    
    db.run(sql, [referralCode, userId], function(err) {
        if (err) {
            console.error("DB Error:", err.message);
            return res.status(500).send("Error making agent");
        }
        res.redirect('/admin'); // Babalik sa admin page
    });
});

// Alisin ang pagka-Agent 
app.post('/admin/remove-agent', ensureAdmin, (req, res) => {
    const userId = req.body.user_id;

    const sql = `UPDATE users SET is_agent = 0, referral_code = NULL WHERE id = ?`;

    db.run(sql, [userId], function(err) {
        if (err) {
            console.error("DB Error:", err.message);
            return res.status(500).send("Error removing agent");
        }
        res.redirect('/admin');
    });
});

// Gawing Coadmin ang Player
app.post('/admin/make-coadmin', ensureAdmin, (req, res) => {
    const userId = req.body.user_id;

    const sql = `UPDATE users SET is_coadmin = 1 WHERE id = ?`;
    
    db.run(sql, [userId], function(err) {
        if (err) {
            console.error("DB Error:", err.message);
            req.flash('error', 'Error making coadmin');
            return res.status(500).send("Error making coadmin");
        }
        req.flash('success', 'User is now a Coadmin!');
        res.redirect('/admin'); 
    });
});

// Alisin ang pagka-Coadmin
app.post('/admin/remove-coadmin', ensureAdmin, (req, res) => {
    const userId = req.body.user_id;

    const sql = `UPDATE users SET is_coadmin = 0 WHERE id = ?`;

    db.run(sql, [userId], function(err) {
        if (err) {
            console.error("DB Error:", err.message);
            req.flash('error', 'Error removing coadmin');
            return res.status(500).send("Error removing coadmin");
        }
        req.flash('success', 'Coadmin access removed.');
        res.redirect('/admin');
    });
});

app.post('/admin/jackpot/update', (req, res) => {
    const { jackpot } = req.body;

    db.run(
        "UPDATE settings SET value = ? WHERE key = 'jackpot_prize'",
        [jackpot],
        (err) => {
            if (err) {
                console.log(err);
                return res.send("Error updating jackpot");
            }
            res.redirect('/admin');
        }
    );
});



// ==========================================
// 13. CHAT BOX SUPPORT ADMIN AND CO ADMIN
// ==========================================

//Admin/Coadmin View 
app.get('/support/messages', ensureCoadmin, (req, res) => {

    db.all(
        `
        SELECT 
            customer_messages.*,
            users.name
        FROM customer_messages
        LEFT JOIN users
        ON users.id = customer_messages.user_id
        ORDER BY created_at DESC
        `,
        [],
        (err, rows) => {

            res.render('support_admin', {
                user: req.user,
                messages: rows || []
            });

        }
    );

});

//Admin/Coadmin Reply to Customer

app.post('/support/reply', ensureCoadmin, (req, res) => {

    const { user_id, message } = req.body;

    db.run(
        `
        INSERT INTO customer_messages
        (user_id, sender, message, created_at)
        VALUES (?, ?, ?, ?)
        `,
        [
            user_id,
            'admin',
            message,
            new Date().toISOString()
        ],
        () => {

            res.redirect('/support/messages');

        }
    );

});


//Player View Only

app.post('/customer-service/send', ensureAuthenticated, (req, res) => {

    const { message } = req.body;

    if (!message || message.trim() === '') {
        return res.status(400).json({
            error: 'Empty message'
        });
    }

    db.run(
        `
        INSERT INTO support_messages
        (user_id, sender, message, created_at)
        VALUES (?, ?, ?, ?)
        `,
        [
            req.user.id,
            'user',
            message,
            new Date().toISOString()
        ],
        (err) => {

            if (err) {

                console.log(err);

                return res.status(500).json({
                    error:'Database error'
                });

            }

            res.json({
                success:true
            });

        }
    );

});


app.get('/customer-service/messages', ensureAuthenticated, (req, res) => {

    db.all(`
        SELECT 
            support_messages.*,
            users.name AS user_name
        FROM support_messages
        LEFT JOIN users ON users.id = support_messages.user_id
        WHERE support_messages.user_id = ?
        ORDER BY support_messages.id ASC
    `,
    [req.user.id],
    (err, rows) => {

        if (err) {
            console.log(err);
            return res.json([]);
        }

        res.json(rows);

    });

});

// LIST USERS WITH MESSAGES
app.get('/admin/support', ensureAdminOrCoadmin, (req, res) => {

    db.all(`
        SELECT 
            support_messages.user_id,
            users.name AS user_name
        FROM support_messages
        LEFT JOIN users ON users.id = support_messages.user_id
        GROUP BY support_messages.user_id
        ORDER BY MAX(support_messages.id) DESC
    `, [], (err, rows) => {

        res.render('support_admin', {
            user: req.user,
            users: rows || []
        });

    });

});
// GET MESSAGES PER USER
app.get('/admin/support/messages/:userId', ensureAdminOrCoadmin, (req, res) => {

 db.all(`
    SELECT 
        support_messages.*,
        users.name AS user_name
    FROM support_messages
    LEFT JOIN users ON users.id = support_messages.user_id
    WHERE support_messages.user_id = ?
    ORDER BY support_messages.id ASC
    `, [req.params.userId], (err, rows) => {

        res.json(rows || []);

    });

});

// ADMIN REPLY
app.post('/admin/support/reply', ensureAdminOrCoadmin, (req, res) => {

    const { user_id, message } = req.body;

    db.run(`
        INSERT INTO support_messages
        (user_id, sender, message, created_at)
        VALUES (?, 'admin', ?, ?)
    `, [
        user_id,
        message,
        new Date().toISOString()
    ]);

    res.json({ success:true });

});

// ==========================================
// ERROR HANDLER
// ==========================================

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

// ==========================================
// 14. SERVER START
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
console.log("🚀 BASE_URL:", BASE_URL);
console.log("🚀 SERVER STARTED ON PORT:", PORT);