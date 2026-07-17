# Kite Streamer

Optional long-running Kite WebSocket bridge for live ticks. Netlify Functions are
request/response only, so true Kite streaming must run in a persistent Node
process on a home machine, VPS, Render, Fly, Railway, or similar host.

## Run locally

```bash
cd kite-streamer
npm install
copy env.example .env
npm start
```

The service reads `system_settings.kite_access_token` from Supabase unless
`KITE_ACCESS_TOKEN` is set directly. The token still needs the existing daily
`kite-token-refresh` flow.

## Browser WebSocket

```text
ws://localhost:8787/stream?symbols=RELIANCE,SBIN,TCS
```

Messages are JSON:

```json
{"type":"tick","symbol":"RELIANCE","tick":{"last_price":1321.3}}
```

The current Netlify chart remains on candle polling until this service is
hosted and a public `REACT_APP_KITE_STREAM_URL` is configured.
