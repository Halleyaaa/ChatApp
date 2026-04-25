require('dotenv').config();


const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT         = process.env.PORT || 3001;
const JWT_SECRET   = process.env.JWT_SECRET   || 'chatapp_secret_2024';
const GEMINI_KEY   = process.env.GEMINI_API_KEY || '';
const MONGO_URI    = process.env.MONGO_URI; // bắt buộc từ .env
const UPLOADS_DIR  = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── MongoDB Schemas ──────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  id:          { type: String, default: () => uuidv4(), unique: true },
  username:    { type: String, required: true, unique: true, trim: true },
  password:    { type: String, required: true },
  displayName: { type: String, default: '' },
  avatar:      { type: String, default: '' },
  online:      { type: Boolean, default: false },
  createdAt:   { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  id:          { type: String, default: () => uuidv4() },
  roomKey:     { type: String, required: true, index: true },
  senderId:    { type: String, required: true },
  receiverId:  { type: String, required: true },
  content:     { type: String, default: '' },
  type:        { type: String, default: 'text' },
  fileName:    String,
  fileSize:    Number,
  senderName:  String,
  senderAvatar:String,
  read:        { type: Boolean, default: false },
  timestamp:   { type: Date, default: Date.now }
});

const friendSchema = new mongoose.Schema({
  id:         { type: String, default: () => uuidv4() },
  userId:     { type: String, required: true },
  friendId:   { type: String, required: true },
  status:     { type: String, enum: ['pending','accepted'], default: 'pending' },
  createdAt:  { type: Date, default: Date.now },
  acceptedAt: Date
});

const groupSchema = new mongoose.Schema({
  id:        { type: String, default: () => uuidv4(), unique: true },
  name:      { type: String, required: true },
  avatar:    String,
  createdBy: String,
  members:   [String],
  admins:    [String],
  createdAt: { type: Date, default: Date.now }
});

const User    = mongoose.model('User',    userSchema);
const Message = mongoose.model('Message', messageSchema);
const Friend  = mongoose.model('Friend',  friendSchema);
const Group   = mongoose.model('Group',   groupSchema);

// ─── Connect MongoDB ──────────────────────────────────────────────────────────
async function connectDB() {
  if (!MONGO_URI) {
    console.error('❌ MONGO_URI chưa được thiết lập trong .env!');
    process.exit(1);
  }

  let uri = MONGO_URI;
  if (/\.mongodb\.net\/?(\?|$)/.test(uri)) {
    uri = uri.replace(/\.mongodb\.net\/?(\?)/, '.mongodb.net/chatapp$1');
    console.log('[DB] Đã tự động thêm database name: chatapp');
  }

  const opts = {
    family:              4,       
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS:         10000,
    socketTimeoutMS:          45000,
  };

  let retries = 3;
  while (retries > 0) {
    try {
      await mongoose.connect(uri, opts); 
      console.log('MongoDB connected!');
      return;
    } catch (e) {
      retries--;
      console.error(`MongoDB connection failed (còn ${retries} lần thử):`, e.message);
      if (retries === 0) {
        console.error('\n 1. Vào Atlas → Network Access → Add 0.0.0.0/0\n  2. Kiểm tra username/password trong MONGO_URI\n  3. Đảm bảo MONGO_URI có tên database: .../chatapp?...');
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, 3000)); // chờ 3s rồi thử lại
    }
  }
}

// ─── Bot Engine ───────────────────────────────────────────────────────────────
let trainer = { intents: [] };
try {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'trainer.json'), 'utf8'));
  if (data?.intents) trainer = data;
} catch { console.warn('[BOT] trainer.json not found'); }

async function getBotResponse(message) {
  const inputText = typeof message === 'string' ? message : String(message || '');
  const msg = inputText.toLowerCase().trim();

  // 1. Local trainer
  let bestMatch = null, bestScore = 0;
  for (const intent of (trainer.intents || [])) {
    if (intent.tag === 'default') continue;
    for (const pattern of intent.patterns) {
      const p = pattern.toLowerCase();
      if (msg.includes(p) || p.includes(msg)) {
        const score = p.length / Math.max(msg.length, p.length);
        if (score > bestScore) { bestScore = score; bestMatch = intent; }
      }
    }
  }
  if (bestMatch && bestScore > 0.3) {
    const r = bestMatch.responses;
    return r[Math.floor(Math.random() * r.length)];
  }

  // 2. Gemini
  if (GEMINI_KEY) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: inputText }] }] }) }
      );
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return String(text);
    } catch (e) { console.error('[Gemini]', e.message); }
  }

  // 3. Default
  const def = (trainer.intents || []).find(i => i.tag === 'default');
  const d = def?.responses || ['Xin lỗi, tôi chưa hiểu ý bạn.'];
  return d[Math.floor(Math.random() * d.length)];
}

// ─── Express Setup ────────────────────────────────────────────────────────────
const app = express();

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));

// Serve client
const CLIENT_DIR = path.join(__dirname, '..', 'client');
if (fs.existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR));
  app.get('/', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));
  app.get('/chat', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'chat.html')));
}

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /jpeg|jpg|png|gif|webp|mp3|wav|ogg|mp4|pdf|doc|docx|txt|zip/;
    cb(null, ok.test(path.extname(file.originalname).toLowerCase().slice(1)));
  }
});

// Auth middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// Safe WS send
function safeSend(ws, data) {
  try {
    if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(data)); return true; }
  } catch(e) { console.error('[WS] Send:', e.message); }
  return false;
}

// ─── API: Auth ────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Thiếu thông tin' });
    if (username.length < 3)   return res.status(400).json({ error: 'Username ≥ 3 ký tự' });
    if (password.length < 6)   return res.status(400).json({ error: 'Password ≥ 6 ký tự' });
    if (await User.findOne({ username })) return res.status(409).json({ error: 'Username đã tồn tại' });

    const user = new User({
      username,
      password:    await bcrypt.hash(password, 10),
      displayName: displayName || username,
      avatar:      `https://api.dicebear.com/7.x/bottts/svg?seed=${username}`
    });
    await user.save();
    const { password: _, ...safe } = user.toObject();
    res.status(201).json({ message: 'Đăng ký thành công!', user: safe });
  } catch(e) { console.error('[register]', e); res.status(500).json({ error: 'Lỗi server' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Thiếu thông tin' });
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: 'Tài khoản không tồn tại' });
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Sai mật khẩu' });

    await User.updateOne({ _id: user._id }, { online: true });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    const { password: _, ...safe } = user.toObject();
    res.json({ token, user: { ...safe, online: true } });
  } catch(e) { console.error('[login]', e); res.status(500).json({ error: 'Lỗi server' }); }
});

app.post('/api/logout', auth, async (req, res) => {
  try {
    await User.updateOne({ id: req.user.id }, { online: false });
    res.json({ message: 'Logged out' });
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

// ─── API: Users ───────────────────────────────────────────────────────────────
app.get('/api/users', auth, async (req, res) => {
  try {
    const users = await User.find({ id: { $ne: req.user.id } }, '-password');
    const safe = users.map(u => u.toObject());
    safe.unshift({ id:'bot', username:'chatbot', displayName:'🤖 ChatBot AI',
      avatar:'https://api.dicebear.com/7.x/bottts/svg?seed=robot', online:true, isBot:true });
    res.json(safe);
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

app.get('/api/users/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const regex = new RegExp(q, 'i');
    const users = await User.find({
      id: { $ne: req.user.id },
      $or: [{ username: regex }, { displayName: regex }]
    }, '-password');

    const results = await Promise.all(users.map(async u => {
      const rel = await Friend.findOne({
        $or: [{ userId: req.user.id, friendId: u.id }, { userId: u.id, friendId: req.user.id }]
      });
      return { ...u.toObject(), friendStatus: rel?.status || 'none', friendRequestFrom: rel?.userId || null };
    }));
    res.json(results);
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

// ─── API: Friends ─────────────────────────────────────────────────────────────
app.get('/api/friends', auth, async (req, res) => {
  try {
    const rels = await Friend.find({
      $or: [{ userId: req.user.id }, { friendId: req.user.id }],
      status: 'accepted'
    });
    const ids = rels.map(r => r.userId === req.user.id ? r.friendId : r.userId);
    const users = await User.find({ id: { $in: ids } }, '-password');
    res.json(users.map(u => u.toObject()));
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

app.get('/api/friends/requests', auth, async (req, res) => {
  try {
    const pending = await Friend.find({ friendId: req.user.id, status: 'pending' });
    const results = await Promise.all(pending.map(async r => {
      const u = await User.findOne({ id: r.userId }, '-password');
      if (!u) return null;
      return { ...u.toObject(), requestId: r.id };
    }));
    res.json(results.filter(Boolean));
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

app.post('/api/friends/request', auth, async (req, res) => {
  try {
    const { targetId } = req.body;
    if (!targetId || targetId === req.user.id) return res.status(400).json({ error: 'targetId không hợp lệ' });
    const exists = await Friend.findOne({
      $or: [{ userId: req.user.id, friendId: targetId }, { userId: targetId, friendId: req.user.id }]
    });
    if (exists) return res.status(409).json({ error: 'Đã tồn tại quan hệ bạn bè' });
    const newReq = new Friend({ userId: req.user.id, friendId: targetId });
    await newReq.save();
    res.json({ message: 'Đã gửi lời mời', request: newReq });
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

app.post('/api/friends/accept', auth, async (req, res) => {
  try {
    const { requestId } = req.body;
    const r = await Friend.findOneAndUpdate(
      { id: requestId, friendId: req.user.id },
      { status: 'accepted', acceptedAt: new Date() },
      { new: true }
    );
    if (!r) return res.status(404).json({ error: 'Không tìm thấy' });
    res.json({ message: 'Đã chấp nhận' });
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

app.post('/api/friends/reject', auth, async (req, res) => {
  try {
    const { requestId } = req.body;
    await Friend.deleteOne({ id: requestId, friendId: req.user.id });
    res.json({ message: 'Đã từ chối' });
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

app.delete('/api/friends/:friendId', auth, async (req, res) => {
  try {
    const { friendId } = req.params;
    await Friend.deleteOne({
      $or: [{ userId: req.user.id, friendId }, { userId: friendId, friendId: req.user.id }]
    });
    res.json({ message: 'Đã hủy kết bạn' });
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

// ─── API: Groups ──────────────────────────────────────────────────────────────
app.get('/api/groups', auth, async (req, res) => {
  try {
    const groups = await Group.find({ members: req.user.id });
    res.json(groups.map(g => g.toObject()));
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

app.post('/api/groups', auth, async (req, res) => {
  try {
    const { name, memberIds } = req.body;
    if (!name) return res.status(400).json({ error: 'Tên nhóm là bắt buộc' });
    const members = [...new Set([req.user.id, ...(memberIds || [])])];
    if (members.length < 2) return res.status(400).json({ error: 'Cần ít nhất 2 người' });
    const group = new Group({
      name,
      avatar:    `https://api.dicebear.com/7.x/identicon/svg?seed=${Date.now()}`,
      createdBy: req.user.id,
      members,
      admins:    [req.user.id]
    });
    await group.save();
    res.status(201).json({ message: 'Tạo nhóm thành công!', group: group.toObject() });
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

app.delete('/api/groups/:groupId/leave', auth, async (req, res) => {
  try {
    const group = await Group.findOne({ id: req.params.groupId });
    if (!group) return res.status(404).json({ error: 'Nhóm không tồn tại' });
    group.members = group.members.filter(id => id !== req.user.id);
    group.admins  = group.admins.filter(id => id !== req.user.id);
    if (group.members.length === 0) await group.deleteOne();
    else await group.save();
    res.json({ message: 'Đã rời nhóm' });
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

// ─── API: Messages ────────────────────────────────────────────────────────────
app.get('/api/messages/:chatId', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    let roomKey;
    if (chatId === 'bot')              roomKey = `${req.user.id}_bot`;
    else if (chatId.startsWith('group_')) roomKey = chatId;
    else                               roomKey = [req.user.id, chatId].sort().join('_');
    const msgs = await Message.find({ roomKey }).sort({ timestamp: 1 }).lean();
    res.json(msgs);
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

// ─── API: Upload ──────────────────────────────────────────────────────────────
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const baseUrl = process.env.SERVER_URL || `http://localhost:${PORT}`;
    const url = `${baseUrl}/uploads/${req.file.filename}`;
    const ext = path.extname(req.file.originalname).toLowerCase();
    let type = 'file';
    if (/\.(jpg|jpeg|png|gif|webp)$/.test(ext)) type = 'image';
    else if (/\.(mp3|wav|ogg)$/.test(ext))      type = 'audio';
    else if (/\.(mp4|webm)$/.test(ext))         type = 'video';
    res.json({ url, type, name: req.file.originalname, size: req.file.size });
  } catch { res.status(500).json({ error: 'Upload thất bại' }); }
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const clients = new Map();

wss.on('connection', (ws) => {
  let userId = null;

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Auth
      if (msg.type === 'auth') {
        try {
          const decoded = jwt.verify(msg.token, JWT_SECRET);
          userId = decoded.id;
          clients.set(userId, ws);
          await User.updateOne({ id: userId }, { online: true });
          safeSend(ws, { type: 'auth_ok', userId });
          broadcastStatus(userId, true);
          console.log(`[WS] ${decoded.username}`);
        } catch { safeSend(ws, { type: 'error', message: 'Invalid token' }); }
        return;
      }
      if (!userId) return;

      // Message
      if (msg.type === 'message') {
        const { to, content, messageType = 'text', fileName, fileSize } = msg;
        if (!content && messageType === 'text') return;

        let roomKey;
        if (to === 'bot')              roomKey = `${userId}_bot`;
        else if (to.startsWith('group_')) roomKey = to;
        else                           roomKey = [userId, to].sort().join('_');

        const msgDoc = new Message({
          roomKey, senderId: userId, receiverId: to,
          content, type: messageType,
          fileName: fileName || null, fileSize: fileSize || null
        });

        // Thêm info người gửi cho nhóm
        if (to.startsWith('group_')) {
          const sender = await User.findOne({ id: userId }, 'displayName avatar');
          msgDoc.senderName   = sender?.displayName || '';
          msgDoc.senderAvatar = sender?.avatar || '';
        }

        await msgDoc.save();
        const msgData = msgDoc.toObject();

        safeSend(ws, { type: 'message_sent', message: msgData });

        // Gửi đến nhóm
        if (to.startsWith('group_')) {
          const groupId = to.replace('group_', '');
          const group = await Group.findOne({ id: groupId });
          if (group) {
            group.members.forEach(mid => {
              if (mid !== userId) {
                const mws = clients.get(mid);
                if (mws) safeSend(mws, { type: 'message', message: msgData });
              }
            });
          }
        }
        // Gửi 1-1
        else if (to !== 'bot') {
          const rws = clients.get(to);
          if (rws) safeSend(rws, { type: 'message', message: msgData });
        }
        // Bot reply
        else {
          safeSend(ws, { type: 'typing', from: 'bot', isTyping: true });
          const replyText = await getBotResponse(content);
          const botMsg = new Message({
            roomKey, senderId: 'bot', receiverId: userId,
            content: String(replyText), type: 'text'
          });
          await botMsg.save();
          setTimeout(() => {
            safeSend(ws, { type: 'typing', from: 'bot', isTyping: false });
            safeSend(ws, { type: 'message', message: botMsg.toObject() });
          }, 800);
        }
      }

      // Typing
      if (msg.type === 'typing') {
        if (msg.to?.startsWith('group_')) {
          const group = await Group.findOne({ id: msg.to.replace('group_','') });
          if (group) {
            group.members.forEach(mid => {
              if (mid !== userId) {
                const mws = clients.get(mid);
                if (mws) safeSend(mws, { type:'typing', from:userId, to:msg.to, isTyping:msg.isTyping });
              }
            });
          }
        } else {
          const rws = clients.get(msg.to);
          if (rws) safeSend(rws, { type:'typing', from:userId, isTyping:msg.isTyping });
        }
      }

      // Friend notify
      if (msg.type === 'friend_notify') {
        const rws = clients.get(msg.to);
        if (rws) safeSend(rws, { type: msg.event, from: userId });
      }

      // Mark read
      if (msg.type === 'read') {
        const roomKey = [userId, msg.from].sort().join('_');
        await Message.updateMany({ roomKey, receiverId: userId }, { read: true });
      }

    } catch(e) { console.error('[WS] Error:', e.message); }
  });

  ws.on('close', async () => {
    if (userId) {
      clients.delete(userId);
      broadcastStatus(userId, false);
      await User.updateOne({ id: userId }, { online: false }).catch(() => {});
      console.log(`[WS] ${userId}`);
    }
  });

  ws.on('error', err => console.error('[WS] Socket:', err.message));
});

function broadcastStatus(userId, online) {
  clients.forEach((cws, id) => {
    if (id !== userId) safeSend(cws, { type:'user_status', userId, online });
  });
}

// ─── Error Handlers ───────────────────────────────────────────────────────────
process.on('uncaughtException',  err => console.error('[SERVER] Uncaught:', err.message));
process.on('unhandledRejection', r   => console.error('[SERVER] Rejection:', r));

// ─── Start ────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  // '0.0.0.0' → bind tất cả interface: localhost + LAN IP + Render
  server.listen(PORT, '0.0.0.0', () => {
    // Lấy IP LAN để in ra console cho tiện
    const os = require('os');
    const lanIP = Object.values(os.networkInterfaces())
      .flat().find(i => i.family === 'IPv4' && !i.internal)?.address || 'unknown';

    console.log(`\n╔══════════════════════════════════════════════╗`);
    console.log(`║        ChatApp Server — MongoDB              ║`);
    console.log(`║  Local  → http://localhost:${PORT}              ║`);
    console.log(`║  LAN    → http://${lanIP}:${PORT}`.padEnd(49) + '║');
    console.log(`║  WS     → ws://0.0.0.0:${PORT} (all interfaces) ║`);
    console.log(`╚══════════════════════════════════════════════╝\n`);
    console.log('Gemini:', GEMINI_KEY ? 'ENABLED ○ ' : 'DISABLED');
    console.log('○ Ready! Listening on ALL interfaces\n');
  });
});