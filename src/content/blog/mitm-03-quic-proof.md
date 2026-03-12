---
title: 'The QUIC Proof'
description: 'After WebSocket connections are killed over TCP, clients fall back to QUIC — and it works. The TCP/QUIC asymmetry is the structural fingerprint of a middlebox.'
pubDate: '2026-03-11'
series: 'Infrastructure MITM Investigation'
seriesPart: 3
tags: ['networking', 'security', 'quic', 'tcp', 'mitm']
---

# The QUIC Proof

In the [previous post](/effective-address/blog/mitm-02-websocket-downgrade), I documented how WebSocket connections to OpenAI are killed with correct-sequence TCP FINs. What happens next is the strongest single piece of evidence in this investigation.

## TCP fails, QUIC succeeds

After the WebSocket path is rejected, the client falls back to HTTPS. But it doesn't just switch endpoints — it switches *transport protocols*. The chatgpt.com HTTPS fallback traffic is 97% QUIC/UDP versus 3% TCP.

This means: the same client, same API credentials, same source IP, reaching the same logical service — fails on TCP WebSocket but succeeds on QUIC HTTP/3.

## Why this eliminates the server-side explanation

If OpenAI rejected this client (rate limit, policy, auth, geo-restriction), the rejection would apply to the **client identity**, not the **transport layer**. Server-side policy doesn't care whether packets arrive as TCP segments or QUIC datagrams. The API key, client fingerprint, and source IP are identical on both transports.

But a TCP-layer middlebox cares enormously:

| Capability | TCP | QUIC |
|---|---|---|
| Read SNI from ClientHello | Yes (plaintext in first flight) | Encrypted (ECH / QUIC crypto) |
| Track connection state | Yes (sequence numbers, flags) | No (encrypted transport headers) |
| Inject FIN/RST | Yes (forge with known seq#) | No (requires connection keys) |
| Identify connection as LLM traffic | Yes (via SNI) | Extremely difficult |

A transparent TCP proxy can:
- Read the TLS ClientHello to see `ws.chatgpt.com` in the SNI field
- Track the TCP state machine (sequence numbers, window size)
- Inject a FIN packet with the correct sequence number at the right moment

It **cannot**:
- Read QUIC packet contents (encrypted from the first flight, including connection metadata)
- Inject a QUIC `CONNECTION_CLOSE` frame (requires the connection's TLS-derived keys)
- Even reliably determine which QUIC connections carry LLM traffic

The TCP/QUIC asymmetry is not a coincidence. It's the structural fingerprint of a device that operates at TCP layer 4, is blind to QUIC's encrypted transport, and is positioned on the network path between client and server.

## What about Cloudflare?

One counterargument: "Cloudflare's infrastructure might handle TCP and QUIC connections differently." This is true in the trivial sense that they're different protocol stacks. But Cloudflare's edge proxies terminate both TCP and QUIC, then proxy to the same origin servers. From OpenAI's perspective, the request is identical regardless of which transport delivered it.

More importantly: `ws.chatgpt.com` (the WebSocket endpoint) is **100% TCP, 0% UDP** in the capture. WebSocket runs over TCP by definition. If the client could reach `ws.chatgpt.com` via QUIC, it wouldn't need to fall back to `chatgpt.com` at all. The fact that the WebSocket endpoint is exclusively TCP means the client *has no QUIC escape route* for its preferred transport — it's forced onto HTTPS, where QUIC happens to work because the middlebox can't interfere with it.

## The I2P correlation

I2P traffic on the same connection also shows corruption — bytes modified in transit that pass TCP checksum validation. This is mechanistically consistent with the transparent proxy model: if a proxy terminates TCP session A and originates TCP session B, it recalculates checksums on session B. Any byte errors introduced by the proxy's buffer handling appear as valid TCP on both sides but corrupt data at the application layer.

I2P's internal encryption (AES-256-CBC + HMAC-SHA256) should catch corruption at the tunnel layer. For corrupted data to reach the I2P application, the corruption must occur *below* the tunnel transport — at the TCP layer where the proxy operates.

## The single-device model

All of the observed behavior — WebSocket FIN injection, QUIC passthrough, I2P byte corruption — is explained by a single device at hop 8 with TCP state machine ownership:

```
Client ←→ [TCP Session A] ←→ Hop 8 Proxy ←→ [TCP Session B] ←→ Server

- Session A: proxy terminates client's TCP, reads SNI
- Decision: FIN inject (kill WS) or relay (pass through)
- Session B: proxy originates new TCP to real server
- Checksums recalculated on both sides
- TLS validates end-to-end (encrypted payload relayed verbatim)
- QUIC bypasses entirely (no TCP to terminate)
```

No collusion between ISP and CDN required. No compromise of Cloudflare or OpenAI infrastructure. Just one device, at one hop, doing what transparent TCP proxies are designed to do.

---

*This is Part 3 of the [Infrastructure MITM Investigation](/effective-address/blog) series. Next: [All Roads Through ORD](/effective-address/blog/mitm-04-all-roads-through-ord) — TTL analysis reveals every Cloudflare anycast IP is routed to the same point, while other CDNs route correctly.*
