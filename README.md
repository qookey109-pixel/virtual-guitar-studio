# Virtual Guitar Studio v10

瀏覽器內執行的手勢吉他 Web App。

## v10 重點

- 固定右手吉他配置。
- 左手在左側虛擬指板按和弦，辨識到後優先於鍵盤。
- 左手辨識不到時，使用 A/S/D/F/G/H/J/K/L 鍵盤和弦作備援。
- Space 回到 OPEN。
- 右手在右側琴身區可撥單弦、分解和弦、上下刷弦。
- 支援電吉他、民謠吉他、古典吉他、貝斯。
- 自訂鍵位使用 localStorage，設定只存在使用者自己的瀏覽器。
- 相機影像由瀏覽器 MediaPipe HandLandmarker 處理；本套件沒有建立雲端影像儲存。

## 如何執行

相機 API 通常要求 HTTPS 或 localhost，因此不要只用 `file://` 雙擊 index.html。

### Mac 快速測試

在此資料夾開 Terminal：

```bash
python3 -m http.server 8080
```

再開：

http://localhost:8080

### 正式部署

可直接部署到 Render Static Site、Cloudflare Pages、GitHub Pages、Netlify 或 Vercel。
