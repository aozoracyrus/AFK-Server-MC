# mc-afk-bot

Bot AFK cho Paper 26.3. Freeze mode + `client_tick_end` guard.

## Chuẩn bị
Server cần: Paper 26.3 + ViaVersion + ViaBackwards 5.12.2 + plugin login.
Bạn tự vào game bằng tên bot, `/register <pass> <pass>`, rồi thoát.

## Chạy
```bash
npm install
npm run check
cp .env.example .env    # điền MC_HOST, MC_PORT, MC_USERNAME, MC_PASSWORD
npm run ping -- <host> <port>
npm run dev
curl http://localhost:8080/status
```

## AFK_MODE
| Mode | Dùng khi |
|---|---|
| `auto` | freeze nếu server ≥26.3, native nếu thấp hơn |
| `freeze` | không gửi packet movement |
| `tick` | movement thật + tick_end |
| `native` | server ≤26.2 |

## Endpoint
`/health` (health check), `/ready`, `/status`.
