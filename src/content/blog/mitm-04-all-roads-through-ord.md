---
title: 'All Roads Through ORD'
description: 'TTL analysis of tcpdump captures reveals every Cloudflare anycast IP routes to the same destination with identical hop counts, while non-Cloudflare CDNs route correctly.'
pubDate: '2026-03-11'
series: 'Infrastructure MITM Investigation'
seriesPart: 4
tags: ['networking', 'security', 'bgp', 'anycast', 'cloudflare', 'mitm']
---

# All Roads Through ORD

Cloudflare operates one of the largest anycast networks in the world. The premise of anycast is simple: the same IP address is announced from hundreds of data centers, and BGP routing delivers your packets to the *nearest* one. From a residential connection in the Mountain/Central US, you'd expect to hit Denver (DEN), Dallas (DFW), or Kansas City (MCI).

Every Cloudflare IP I tested hits the same place.

## The TTL table

I extracted TTL values from tcpdump captures for every Cloudflare-fronted IP my system connects to. TTL (Time to Live) decrements by 1 at each hop, so identical TTLs from different IPs mean identical hop counts — and by extension, the same routing path.

| IP | Hostname | Service | TTL | Hops (64 - TTL) |
|---|---|---|---|---|
| 104.18.39.21 | ws.chatgpt.com | OpenAI WS | 55 | 9 |
| 172.64.148.235 | ws.chatgpt.com | OpenAI WS | 55 | 9 |
| 104.18.32.47 | chatgpt.com | OpenAI HTTPS | 55 | 9 |
| 172.64.155.209 | chatgpt.com | OpenAI HTTPS | 55 | 9 |
| 162.159.140.245 | api.openai.com | OpenAI API | 55 | 9 |
| 162.159.140.229 | api.openai.com | OpenAI API | 55 | 9 |
| 104.18.41.241 | auth.openai.com | OpenAI Auth | 55 | 9 |
| 172.64.146.15 | auth.openai.com | OpenAI Auth | 55 | 9 |
| 172.66.0.243 | api.openai.com | OpenAI API | 55 | 9 |
| 172.66.0.227 | cdn.oaistatic.com | OpenAI CDN | 55 | 9 |
| 104.18.39.21 | ws.chatgpt.com | OpenAI WS | 55 | 9 |
| 160.79.104.10 | api.anthropic.com | Anthropic | 55 | 9 |

**Twelve IPs. Eight hostnames. Four different services. Two different companies. All TTL 55.**

## The control group

Non-Cloudflare CDNs from the same connection, same time window:

| IP | Service | CDN | TTL | Hops |
|---|---|---|---|---|
| 18.97.36.53 | Various | CloudFront | 234 | 21 (from 255) or 22 (from 256) |
| 142.250.x.x | Google APIs | Google | 117 | 11 (from 128) |
| 151.101.x.x | Reddit/Fastly | Fastly | 55 | 9 |

CloudFront routes to a completely different hop count. Google routes to 11 hops. These CDNs are making independent routing decisions and landing at different PoPs — which is how anycast is supposed to work.

The Cloudflare traffic is not doing this. Every prefix, every IP, every service converges to the same path with the same hop count.

## The latency anomaly

MTR traces show the actual latency breakdown:

```
Hops 1-7  (LAN + Vyve internal):    23.6ms
Hop 8     (??? → Cogent):            +0.5ms
Hops 9-12 (Cogent → CF → dest):     +0.1ms
Total:                               ~24.2ms
```

The Vyve-internal network consumes ~20ms of latency. The remaining 3+ network hops from hop 8 through Cogent, through Cloudflare's backbone, to the destination add less than 1ms combined.

For context: the speed of light in fiber covers about 200km per millisecond (round-trip). Sub-millisecond latency across three network hops means those hops are either:
- Physically colocated (same building or campus)
- Not real network hops at all

If Cogent's nearest Cloudflare peering were in Denver (~600km from typical Vyve service areas in Arkansas/Oklahoma/Missouri), you'd expect at least 6-8ms of additional propagation delay. We see 0.5ms.

## Two Cogent routers, one destination

The MTR traces also revealed that Anthropic (api.anthropic.com) takes a different Cogent router (38.142.64.154) than all three OpenAI endpoints (38.122.181.134). Two different internal Cogent paths. Yet both arrive at the same Cloudflare backbone entry point (141.101.73.16) with the same total hop count and the same final latency.

In normal anycast, different destination prefixes follow different BGP paths to different PoPs. Here, different paths converge to the same result. That's consistent with a convergence point before Cogent — a device at hop 8 that routes everything to the same destination regardless of which Cogent router comes next.

---

*This is Part 4 of the [Infrastructure MITM Investigation](/transit-observer/blog) series. Next: [Against the Mundane Narrative](/transit-observer/blog/mitm-05-against-the-mundane) — systematically dismantling the "boring infrastructure" explanation.*
