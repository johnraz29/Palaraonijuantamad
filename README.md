# Creative Online Draw (Demo)


Simple demo web app for an online draw lottery.


Key features:
- User registration and login
- Top-up (GCash simulated) - creates pending top-up; admin approves to credit user
- Place bets (6 unique numbers between 1 and 50), ₱20 per bet
- Bets allowed Monday to Friday only (server checks Asia/Manila timezone)
- Admin enters official Saturday result; app automatically finds winners and credits accounts
- Withdraw requests (admin approves to mark as paid)


**Important:** This is a demo scaffold. Real payment integration (GCash API / QR) must follow legal/regulatory and platform requirements. Use this code for local testing and modify according to law.


## Install & Run
1. Save files as provided in this project tree.
2. `npm install`
3. `npm run dev` (requires nodemon) or `npm start`
4. Visit `http://localhost:3000`


Admin default user will be created on first run: email `admin@example.com` password `adminpass`.