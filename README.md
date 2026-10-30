# Tiếng Nga của tôi

Web app cá nhân học tiếng Nga giao tiếp (người Việt, biết tiếng Đức và tiếng Anh). Chạy offline trên iPhone sau khi "Thêm vào Màn hình chính".

- Lộ trình 12 chủ đề; video nhúng từ Russki with Andrei, Easy Russian with Tony, Wossow (chỉ nhúng, không lưu video).
- Nội dung bài học nằm trong `content/*.json`, tách khỏi code.
- Tiến độ lưu trên máy (localStorage), có sao lưu/khôi phục bằng file JSON.
- Chấm AI (Whisper trên Cloudflare Workers AI + Gemini gói miễn phí) sẽ thêm ở bước sau qua một Cloudflare Worker giữ API key.

Chạy thử trên máy: `python3 -m http.server 8000` rồi mở http://localhost:8000.
