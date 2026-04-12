/**
 * ChatApp Server
 * - REST API: Register, Login, Messages, File Upload
 * - WebSocket: Real-time messaging
 * - Bot: Trainer dictionary + optional Gemini API
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'chatapp_super_secret_key_2024';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const DATA_DIR = __dirname;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Khởi tạo file dữ liệu nếu chưa có
['friends.json','groups.json'].forEach(f => {
  const fp = path.join(DATA_DIR, f);
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp, f === 'groups.json' ? '{}' : '[]');
  }
});

// ─── Helpers: File DB ─────────────────────────────────────────────────────────
const readJSON = (file) => {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return (file.includes('messages') || file.includes('groups')) ? {} : [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return (file.includes('messages') || file.includes('groups')) ? {} : []; }
};
const writeJSON = (file, data) => {
  try { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[DB] Write error:', e.message); }
};

// ─── Safe WS Send ─────────────────────────────────────────────────────────────
function safeSend(ws, data) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
      return true;
    }
  } catch (e) { console.error('[WS] Send error:', e.message); }
  return false;
}

// ─── Chatbot Engine ───────────────────────────────────────────────────────────
// Khởi tạo trainer an toàn ngay từ đầu
let trainer = { intents: [] };
try { 
  const data = readJSON('trainer.json'); 
  // Chỉ gán nếu data có mảng intents để chống sập
  if (data && Array.isArray(data.intents)) {
    trainer = data;
  }
} catch { 
  console.warn('[BOT] Lỗi đọc trainer.json, dùng dữ liệu rỗng.'); 
}

// Hàm xử lý chính (Đã gộp Local và API)
async function getBotResponse(message) {
  let inputText = typeof message === 'string' ? message : (message?.content || String(message || ""));
  const msg = inputText.toLowerCase().trim();
  console.log(`[BOT] Đang xử lý: "${msg}"`);

  let bestMatch = null, bestScore = 0;

  // --- 1. LOCAL TRAINER ---
  if (trainer && Array.isArray(trainer.intents)) {
    for (const intent of trainer.intents) {
      if (intent.tag === 'default') continue;
      for (const pattern of intent.patterns) {
        const p = pattern.toLowerCase();
        if (msg.includes(p) || p.includes(msg)) {
          const score = p.length / Math.max(msg.length, p.length);
          if (score > bestScore) { bestScore = score; bestMatch = intent; }
        }
      }
    }
  }

  if (bestMatch && bestScore > 0.3) {
    const r = bestMatch.responses;
    return String(r[Math.floor(Math.random() * r.length)]);
  }

  // --- 2. GEMINI API (Sửa model thành gemini-pro) ---
  if (GEMINI_API_KEY) {
    try {
      console.log(`[BOT] Đang gọi Gemini AI`);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: inputText }] }] }) 
        }
      );
      const data = await res.json();
      const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (aiText) return String(aiText);
      console.warn("[BOT] Gemini không trả về text:", JSON.stringify(data));
    } catch (e) { console.error('[Gemini Error]:', e.message); }
  }

  // --- 3. DEFAULT ---
  const def = (trainer.intents || []).find(i => i.tag === 'default');
  const d = def?.responses || ['Xin lỗi, tôi chưa hiểu ý bạn.'];
  return String(d[Math.floor(Math.random() * d.length)]);
}
// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp3|wav|ogg|mp4|pdf|doc|docx|txt|zip/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase().slice(1)));
  }
});

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ─── API Routes ───────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username và password là bắt buộc' });
    if (username.length < 3) return res.status(400).json({ error: 'Username phải có ít nhất 3 ký tự' });
    if (password.length < 6) return res.status(400).json({ error: 'Password phải có ít nhất 6 ký tự' });
    const users = readJSON('users.json');
    if (users.find(u => u.username === username)) return res.status(409).json({ error: 'Username đã tồn tại' });
    const user = {
      id: uuidv4(), username,
      password: await bcrypt.hash(password, 10),
      displayName: displayName || username,
      avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${username}`,
      createdAt: new Date().toISOString(), online: false
    };
    users.push(user);
    writeJSON('users.json', users);
    const { password: _, ...safe } = user;
    res.status(201).json({ message: 'Đăng ký thành công!', user: safe });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Thiếu thông tin' });
    const users = readJSON('users.json');
    const user = users.find(u => u.username === username);
    if (!user) return res.status(401).json({ error: 'Tài khoản không tồn tại' });
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Sai mật khẩu' });
    user.online = true;
    writeJSON('users.json', users);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    const { password: _, ...safe } = user;
    res.json({ token, user: safe });
  } catch (e) { res.status(500).json({ error: 'Lỗi server' }); }
});

app.post('/api/logout', authMiddleware, (req, res) => {
  try {
    const users = readJSON('users.json');
    const u = users.find(u => u.id === req.user.id);
    if (u) { u.online = false; writeJSON('users.json', users); }
    res.json({ message: 'Logged out' });
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

app.get('/api/users', authMiddleware, (req, res) => {
  try {
    const users = readJSON('users.json');
    const safe = users.filter(u => u.id !== req.user.id).map(({ password, ...u }) => u);
    safe.unshift({ id: 'bot', username: 'chatbot', displayName: '🤖 ChatBot AI',
      avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=robot', online: true, isBot: true });
    res.json(safe);
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});


// ─── API: Tìm kiếm user ───────────────────────────────────────────────────────
app.get('/api/users/search', authMiddleware, (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q) return res.json([]);
    const users = readJSON('users.json');
    const friends = readJSON('friends.json');
    const results = users
      .filter(u => u.id !== req.user.id &&
        (u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q)))
      .map(({ password, ...u }) => {
        const rel = friends.find(f =>
          (f.userId===req.user.id&&f.friendId===u.id)||(f.userId===u.id&&f.friendId===req.user.id));
        return { ...u, friendStatus: rel ? rel.status : 'none', friendRequestFrom: rel?.userId || null };
      });
    res.json(results);
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

// ─── API: Danh sách bạn bè ────────────────────────────────────────────────────
app.get('/api/friends', authMiddleware, (req, res) => {
  try {
    const friends = readJSON('friends.json');
    const users = readJSON('users.json');
    const list = friends
      .filter(f => (f.userId===req.user.id||f.friendId===req.user.id) && f.status==='accepted')
      .map(f => {
        const fid = f.userId===req.user.id ? f.friendId : f.userId;
        const u = users.find(u => u.id===fid);
        if (!u) return null;
        const { password, ...safe } = u;
        return safe;
      }).filter(Boolean);
    res.json(list);
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

// ─── API: Lời mời kết bạn đang chờ ───────────────────────────────────────────
app.get('/api/friends/requests', authMiddleware, (req, res) => {
  try {
    const friends = readJSON('friends.json');
    const users = readJSON('users.json');
    const pending = friends
      .filter(f => f.friendId===req.user.id && f.status==='pending')
      .map(f => {
        const u = users.find(u => u.id===f.userId);
        if (!u) return null;
        const { password, ...safe } = u;
        return { ...safe, requestId: f.id };
      }).filter(Boolean);
    res.json(pending);
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

// ─── API: Gửi lời mời kết bạn ────────────────────────────────────────────────
app.post('/api/friends/request', authMiddleware, (req, res) => {
  try {
    const { targetId } = req.body;
    if (!targetId) return res.status(400).json({ error: 'Thiếu targetId' });
    if (targetId === req.user.id) return res.status(400).json({ error: 'Không thể tự kết bạn' });
    const friends = readJSON('friends.json');
    const exists = friends.find(f =>
      (f.userId===req.user.id&&f.friendId===targetId)||(f.userId===targetId&&f.friendId===req.user.id));
    if (exists) return res.status(409).json({ error: 'Đã tồn tại quan hệ bạn bè' });
    const newReq = { id: uuidv4(), userId: req.user.id, friendId: targetId, status: 'pending', createdAt: new Date().toISOString() };
    friends.push(newReq);
    writeJSON('friends.json', friends);
    res.json({ message: 'Đã gửi lời mời kết bạn', request: newReq });
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

// ─── API: Chấp nhận lời mời ──────────────────────────────────────────────────
app.post('/api/friends/accept', authMiddleware, (req, res) => {
  try {
    const { requestId } = req.body;
    const friends = readJSON('friends.json');
    const req_ = friends.find(f => f.id===requestId && f.friendId===req.user.id);
    if (!req_) return res.status(404).json({ error: 'Không tìm thấy lời mời' });
    req_.status = 'accepted';
    req_.acceptedAt = new Date().toISOString();
    writeJSON('friends.json', friends);
    res.json({ message: 'Đã chấp nhận lời mời' });
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

// ─── API: Từ chối lời mời ────────────────────────────────────────────────────
app.post('/api/friends/reject', authMiddleware, (req, res) => {
  try {
    const { requestId } = req.body;
    const friends = readJSON('friends.json');
    const idx = friends.findIndex(f => f.id===requestId && f.friendId===req.user.id);
    if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy' });
    friends.splice(idx, 1);
    writeJSON('friends.json', friends);
    res.json({ message: 'Đã từ chối' });
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

// ─── API: Hủy kết bạn ────────────────────────────────────────────────────────
app.delete('/api/friends/:friendId', authMiddleware, (req, res) => {
  try {
    const { friendId } = req.params;
    const friends = readJSON('friends.json');
    const idx = friends.findIndex(f =>
      (f.userId===req.user.id&&f.friendId===friendId)||(f.userId===friendId&&f.friendId===req.user.id));
    if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy' });
    friends.splice(idx, 1);
    writeJSON('friends.json', friends);
    res.json({ message: 'Đã hủy kết bạn' });
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

// ─── API: Danh sách nhóm ─────────────────────────────────────────────────────
app.get('/api/groups', authMiddleware, (req, res) => {
  try {
    const groups = readJSON('groups.json');
    const myGroups = Object.values(groups).filter(g => g.members.includes(req.user.id));
    res.json(myGroups);
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

// ─── API: Tạo nhóm ───────────────────────────────────────────────────────────
app.post('/api/groups', authMiddleware, (req, res) => {
  try {
    const { name, memberIds } = req.body;
    if (!name) return res.status(400).json({ error: 'Tên nhóm là bắt buộc' });
    const members = [...new Set([req.user.id, ...(memberIds || [])])];
    if (members.length < 2) return res.status(400).json({ error: 'Nhóm cần ít nhất 2 người' });
    const group = {
      id: uuidv4(), name,
      avatar: `https://api.dicebear.com/7.x/identicon/svg?seed=${Date.now()}`,
      createdBy: req.user.id, members, admins: [req.user.id],
      createdAt: new Date().toISOString()
    };
    const groups = readJSON('groups.json');
    groups[group.id] = group;
    writeJSON('groups.json', groups);
    res.status(201).json({ message: 'Tạo nhóm thành công!', group });
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

// ─── API: Rời nhóm ───────────────────────────────────────────────────────────
app.delete('/api/groups/:groupId/leave', authMiddleware, (req, res) => {
  try {
    const groups = readJSON('groups.json');
    const group = groups[req.params.groupId];
    if (!group) return res.status(404).json({ error: 'Nhóm không tồn tại' });
    group.members = group.members.filter(id => id !== req.user.id);
    group.admins = group.admins.filter(id => id !== req.user.id);
    if (group.members.length === 0) delete groups[req.params.groupId];
    writeJSON('groups.json', groups);
    res.json({ message: 'Đã rời nhóm' });
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

app.get('/api/messages/:chatId', authMiddleware, (req, res) => {
  try {
    const all = readJSON('messages.json');
    const chatId = req.params.chatId;
    let key;
    if (chatId === 'bot') key = `${req.user.id}_bot`;
    else if (chatId.startsWith('group_')) key = chatId;
    else key = [req.user.id, chatId].sort().join('_');
    res.json(all[key] || []);
  } catch { res.status(500).json({ error: 'Lỗi server' }); }
});

app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const url = `http://localhost:${PORT}/uploads/${req.file.filename}`;
    const ext = path.extname(req.file.originalname).toLowerCase();
    let type = 'file';
    if (/\.(jpg|jpeg|png|gif|webp)$/.test(ext)) type = 'image';
    else if (/\.(mp3|wav|ogg)$/.test(ext)) type = 'audio';
    else if (/\.(mp4|webm)$/.test(ext)) type = 'video';
    res.json({ url, type, name: req.file.originalname, size: req.file.size });
  } catch { res.status(500).json({ error: 'Upload thất bại' }); }
});

// ─── HTTP + WebSocket ─────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
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
          safeSend(ws, { type: 'auth_ok', userId });
          broadcastUserStatus(userId, true);
          console.log(`[WS] ✅ Connected: ${decoded.username}`);
        } catch {
          safeSend(ws, { type: 'error', message: 'Invalid token' });
        }
        return;
      }

      if (!userId) return;

      // Send message
    if (msg.type === 'message') {
        const { to, content, messageType = 'text', fileName, fileSize } = msg;
        if (!content && messageType === 'text') return;

        const msgData = {
          id: uuidv4(), senderId: userId, receiverId: to,
          content, type: messageType,
          fileName: fileName || null, fileSize: fileSize || null,
          timestamp: new Date().toISOString(), read: false
        };

        const all = readJSON('messages.json');
        // Tính key lưu message
        let key;
        if (to === 'bot') key = `${userId}_bot`;
        else if (to.startsWith('group_')) key = to;
        else key = [userId, to].sort().join('_');

        // Đính kèm thông tin người gửi cho nhóm
        if (to.startsWith('group_')) {
          const usersData = readJSON('users.json');
          const sender = usersData.find(u => u.id === userId);
          msgData.senderName = sender?.displayName || 'Unknown';
          msgData.senderAvatar = sender?.avatar || '';
        }
        if (!all[key]) all[key] = [];
        all[key].push(msgData);
        writeJSON('messages.json', all);

        // Gửi xác nhận cho người gửi
        safeSend(ws, { type: 'message_sent', message: msgData });

        // Gửi tin nhắn nhóm cho tất cả thành viên
        if (to.startsWith('group_')) {
          const groups = readJSON('groups.json');
          const groupId = to.replace('group_', '');
          const group = groups[groupId];
          if (group) {
            group.members.forEach(mid => {
              if (mid !== userId) {
                const mws = clients.get(mid);
                if (mws) safeSend(mws, { type: 'message', message: msgData });
              }
            });
          }
        } else {
          // Gửi cho người nhận (nếu online)
          const recipientWs = clients.get(to);
          if (recipientWs) safeSend(recipientWs, { type: 'message', message: msgData });
        }

  // Xử lý riêng cho BOT
  if (to === 'bot') {
    safeSend(ws, { type: 'typing', from: 'bot', isTyping: true });

    // Gọi hàm và đợi kết quả
    const replyText = await getBotResponse(content);

    const botMsg = {
      id: uuidv4(),
      senderId: 'bot',
      receiverId: userId,
      content: String(replyText),
      type: 'text',
      timestamp: new Date().toISOString(),
      read: false
    };

    // Lưu phản hồi bot vào database
    const allLatest = readJSON('messages.json');
    if (!allLatest[key]) allLatest[key] = [];
    allLatest[key].push(botMsg);
    writeJSON('messages.json', allLatest);

    // Gửi tin nhắn bot trả về
    setTimeout(() => {
      safeSend(ws, { type: 'typing', from: 'bot', isTyping: false });
      safeSend(ws, { type: 'message', message: botMsg });
    }, 800);
  }
}

      // Typing
      if (msg.type === 'typing') {
        if (msg.to && msg.to.startsWith('group_')) {
          const groups = readJSON('groups.json');
          const gid = msg.to.replace('group_', '');
          const group = groups[gid];
          if (group) {
            group.members.forEach(mid => {
              if (mid !== userId) {
                const mws = clients.get(mid);
                if (mws) safeSend(mws, { type: 'typing', from: userId, to: msg.to, isTyping: msg.isTyping });
              }
            });
          }
        } else {
          const rws = clients.get(msg.to);
          if (rws) safeSend(rws, { type: 'typing', from: userId, isTyping: msg.isTyping });
        }
      }

      // Friend request realtime
      if (msg.type === 'friend_notify') {
        const rws = clients.get(msg.to);
        if (rws) safeSend(rws, { type: msg.event, from: userId });
      }

      // Mark read
      if (msg.type === 'read') {
        try {
          const all = readJSON('messages.json');
          const key = [userId, msg.from].sort().join('_');
          if (all[key]) {
            all[key].forEach(m => { if (m.receiverId === userId) m.read = true; });
            writeJSON('messages.json', all);
          }
        } catch {}
      }

    } catch (e) {
      console.error('[WS] Handler error:', e.message);
      // Không throw — tránh crash
    }
  });

  ws.on('close', () => {
    if (userId) {
      clients.delete(userId);
      broadcastUserStatus(userId, false);
      try {
        const users = readJSON('users.json');
        const u = users.find(u => u.id === userId);
        if (u) { u.online = false; writeJSON('users.json', users); }
      } catch {}
      console.log(`[WS] ❌ Disconnected: ${userId}`);
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] Socket error:', err.message);
  });
});

function broadcastUserStatus(userId, online) {
  clients.forEach((cws, id) => {
    if (id !== userId) safeSend(cws, { type: 'user_status', userId, online });
  });
}

// ─── Global Error Handlers ────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[SERVER] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[SERVER] Unhandled Rejection:', reason);
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║       ChatApp Server Running         ║`);
  console.log(`║  HTTP  → http://localhost:${PORT}       ║`);
  console.log(`║  WS    → ws://localhost:${PORT}         ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  console.log('📁 Data dir:', DATA_DIR);
  console.log('📂 Uploads dir:', UPLOADS_DIR);
  console.log('🤖 Gemini API:', GEMINI_API_KEY ? 'ENABLED ✅' : 'DISABLED (dùng trainer.json)');
  console.log('\n✅ Ready!\n');
});