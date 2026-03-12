---
title: 'The WebSocket Downgrade'
description: 'TCP packet captures reveal a persistent pattern: WebSocket connections to LLM providers are killed with surgically correct FIN packets, forcing fallback to HTTPS — a more inspectable protocol.'
pubDate: '2026-03-11'
series: 'Infrastructure MITM Investigation'
seriesPart: 2
tags: ['networking', 'security', 'tcpdump', 'websocket', 'mitm']
---

# The WebSocket Downgrade

When I started investigating the [silent hop](/transit-observer/blog/mitm-01-the-silent-hop), the first hard evidence came from packet captures. WebSocket connections to OpenAI weren't just failing — they were being killed in a very specific way.

## The pattern

I captured traffic with tcpdump across two sessions (~325,000 lines of output). The WebSocket downgrade pattern was consistent:

1. Client initiates TCP connection to `ws.chatgpt.com` (104.18.39.21 or 172.64.148.235)
2. TLS 1.3 handshake completes successfully
3. HTTP Upgrade request sent, 200-1000 bytes exchanged bidirectionally
4. **Server-initiated FIN** with correct TCP sequence numbers
5. Client reconnects, cycle repeats

Key details:

- **FIN, not RST.** A TCP RST is the blunt instrument of connection teardown — it says "something went wrong." A FIN is a graceful close that says "I'm done talking." Generating a FIN with the correct sequence number requires tracking the TCP state machine for that connection. Routers don't do this. TCP-terminating proxies do.

- **Post-handshake timing.** The kill happens after TLS completes and application data starts flowing. A legitimate server-side rejection (rate limit, auth failure, protocol mismatch) would return an HTTP error during the WebSocket upgrade negotiation. The post-handshake timing suggests something that waited to confirm the session was real before deciding to terminate it.

- **Rejection loop.** The client retries repeatedly, each time completing TLS, exchanging data, and getting FIN'd. No backoff signal is included — no HTTP `Retry-After`, no WebSocket close code 1013. The client sees an unexplained drop and retries per its reconnection logic.

## The fallback

After the WebSocket path fails, clients fall back to HTTPS (chatgpt.com / api.openai.com). The traffic shift is dramatic:

| Endpoint | Protocol | Packets | % |
|---|---|---|---|
| chatgpt.com (HTTPS fallback) | QUIC/UDP | 11,221 | 97.1% |
| chatgpt.com (HTTPS fallback) | TCP | 334 | 2.9% |
| ws.chatgpt.com (WebSocket) | TCP | 1,601 | 100% |
| ws.chatgpt.com (WebSocket) | UDP | 0 | 0% |

The QUIC shift is the most important finding in this investigation, and I'll cover it in detail in the next post.

## Why this matters

The downgrade goes in the wrong direction for a bug or misconfiguration. WebSocket is the *newer*, *preferred* transport for streaming LLM responses. OpenAI invested engineering effort to build `ws.chatgpt.com` specifically for persistent bidirectional streaming. A server-side policy change would push traffic *toward* WebSocket, not away from it.

But from an interception standpoint, the direction makes sense:

- **WebSocket:** persistent bidirectional stream, single long-lived TLS session, harder to decompose into individual request/response pairs
- **HTTPS/SSE:** discrete requests with full HTTP headers per conversation turn, straightforward to log and reconstruct into readable transcripts

The downgrade makes LLM traffic more legible to a passive observer at the TCP layer. It doesn't break encryption — it changes the traffic's *shape* into something easier to work with.

## The FIN sequence numbers

A correct TCP FIN requires knowing the current sequence number of the connection. There are only two entities that should have this:

1. The legitimate server (which would use HTTP-level rejection, not raw TCP FIN)
2. Something that owns the TCP state machine for the connection

Option 2 is a transparent TCP proxy — a device that terminates the client's TCP session on one side and originates a new session to the real server on the other. From both endpoints' perspective, TLS validates correctly because the encrypted stream is relayed end-to-end. But the proxy owns both TCP state machines and can inject FINs at will.

This is not theoretical. It's the exact mechanism used by the VLESS Reality protocol's "wrong secret" path — and it's how commercial traffic inspection appliances operate.

---

*This is Part 2 of the [Infrastructure MITM Investigation](/transit-observer/blog) series. Next: [The QUIC Proof](/transit-observer/blog/mitm-03-quic-proof) — why UDP traffic succeeds where TCP fails, and what that tells us about the device at hop 8.*
