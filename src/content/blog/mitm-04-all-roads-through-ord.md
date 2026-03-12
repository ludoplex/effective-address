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

In normal anycast, different destination prefixes follow different BGP paths to different PoPs. Here, different paths converge to the same result. That's consistent with a convergence point within Cogent's backbone that routes everything to the same destination regardless of which Cogent router comes next.

## The mechanism: anycast hijacking within the backbone

This is the piece that makes the entire chain work.

CDNs like Cloudflare and Fastly use **anycast** — the same IP prefix is announced via BGP from hundreds of data centers worldwide. Your traffic goes to whichever PoP is "nearest" in BGP terms. From central US, that should be Denver, Dallas, or Kansas City.

But **"nearest" is a BGP routing decision, and Cogent controls BGP routing for traffic transiting their backbone.** Cogent can:

1. Announce Cloudflare/Fastly anycast prefixes from within their own network — or route them to an embedded CDN PoP they host internally
2. Make that route "shorter" in BGP path length than the legitimate CDN PoP in Denver
3. All CDN-destined traffic from Vyve subscribers lands at Cogent's chosen termination point

This is why every Cloudflare IP shows identical TTL with sub-millisecond latency from hop 8. The traffic isn't going to Chicago or Denver. It's going to a termination point **local to Cogent's backbone infrastructure** — physically colocated with or embedded within the same facility as the TCP proxy.

## Embedded CDN PoPs and TLS key access

CDNs actively deploy servers inside backbone provider networks as a performance feature. Cloudflare's [Network Interconnect](https://www.cloudflare.com/network-interconnect/) program and similar initiatives place TLS-terminating CDN servers inside transit provider facilities. These servers hold **legitimate TLS private keys** for every domain they front — that's how they terminate HTTPS.

If Cogent hosts embedded Cloudflare/Fastly PoPs in their facilities, they have physical access to servers holding valid TLS keys for millions of domains. Traffic is anycast-hijacked to these local PoPs, TLS is terminated with real certificates (no forged certs, no compromised CA needed), and the plaintext is accessible at the point of termination.

The full chain:

```
Vyve subscriber → TCP to Cloudflare anycast IP
  → Cogent backbone proxy (hides as silent hop, tracks TCP state)
  → BGP anycast routes traffic to embedded CDN PoP inside Cogent
  → Embedded PoP terminates TLS with legitimate CDN certificate
  → Plaintext accessible to Cogent at point of termination
  → Traffic re-originated to real destination or answered locally
```

No certificate forgery. No compromised certificate authority. No breach of Cloudflare corporate infrastructure. Just a backbone provider exercising physical access to CDN hardware deployed inside their own facilities, combined with BGP control over anycast routing for their transit customers.

The "All Roads Through ORD" title was misleading. The roads don't go through ORD. They go through Cogent's interception point, wherever that physically sits. The anycast hijack makes it local.

---

*This is Part 4 of the [Infrastructure MITM Investigation](/effective-address/blog) series. Next: [Against the Mundane Narrative](/effective-address/blog/mitm-05-against-the-mundane) — systematically dismantling the "boring infrastructure" explanation.*
