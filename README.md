# 💬 ChatApp — Hướng dẫn cài đặt & chạy

## Cấu trúc dự án

```
chatapp/
├── client/                  ← Phần giao diện (HTML/JS/CSS)
│   ├── index.html           ← Trang Login / Register
│   └── chat.html            ← Giao diện chat chính
│
└── server/                  ← Máy chủ Node.js
    ├── server.js            ← Server chính
    ├── package.json
    ├── data/
    │   ├── users.json       ← Lưu tài khoản người dùng
    │   ├── messages.json    ← Lưu tin nhắn
    │   └── trainer.json     ← Dữ liệu huấn luyện chatbot
    └── uploads/             ← File được upload
```

---

## ⚙️ Cách chạy

### Bước 1 — Cài đặt server
```bash
cd server
npm install
```

### Bước 2 — Chạy server
```bash
node server.js
```

Server sẽ chạy tại:
- REST API: `http://localhost:3001/api`
- WebSocket: `ws://localhost:3001`

### Bước 3 — Mở client
Dùng **Live Server** (VS Code extension) để mở `client/index.html`  
**Hoặc** mở file trực tiếp bằng trình duyệt.

---

## 🤖 Tích hợp Gemini AI (tùy chọn)

Để chatbot thông minh hơn, thiết lập API key:
```bash
# Windows
set GEMINI_API_KEY=your_key_here

# Linux/Mac
export GEMINI_API_KEY=your_key_here
```

Lấy API key miễn phí tại: https://aistudio.google.com/apikey

---

## ✨ Tính năng

| Tính năng | Mô tả |
|---|---|
| 🔐 Đăng ký / Đăng nhập | Tài khoản, mật khẩu mã hóa bcrypt |
| 💬 Chat realtime | WebSocket, phản hồi tức thì |
| 🤖 ChatBot AI | Dùng trainer.json + tùy chọn Gemini API |
| 📷 Gửi ảnh | Upload & hiển thị inline, lightbox |
| 🎵 Gửi âm thanh | Upload file audio, player tích hợp |
| 📄 Gửi file | PDF, Word, ZIP và nhiều loại khác |
| 😊 Emoji picker | Bộ emoji tích hợp |
| 🟢 Online status | Hiển thị trạng thái realtime |
| ⌨️ Typing indicator | Hiển thị khi đối phương đang gõ |
| 🔒 JWT Auth | Token bảo mật 7 ngày |
| 💾 Lưu trữ JSON | Không cần database, dùng file JSON |

---

## 🎨 Chủ đề đèn

Nhấn vào dây đèn ở trang login để đổi màu chủ đề:
- ⚫ Tắt (dark)
- 🟢 Xanh lá (bật)
- 🟠 Cam (bật)

---

## 📝 Tuỳ chỉnh Bot

Chỉnh sửa file `server/data/trainer.json` để thêm câu hỏi/trả lời:

```json
{
  "tag": "tên_intent",
  "patterns": ["câu hỏi 1", "câu hỏi 2"],
  "responses": ["trả lời 1", "trả lời 2"]
}
```
