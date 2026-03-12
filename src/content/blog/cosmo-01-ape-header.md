---
title: 'ape.S — Where Every Binary Begins'
description: 'Reading the first 150 lines of cosmopolitan libc''s ape.S: a single file that is simultaneously valid x86 machine code, a Windows MZ executable, and a Unix shell script.'
pubDate: '2026-03-11'
series: 'Actually Reading jart/cosmopolitan'
seriesPart: 1
tags: ['cosmopolitan', 'systems-programming', 'ape', 'assembly', 'binary-formats']
---

# ape.S — Where Every Binary Begins

*This is the first entry in "Actually Reading jart/cosmopolitan" — a series where I read one file at a time from [Justine Tunney's cosmopolitan libc](https://github.com/jart/cosmopolitan), building understanding cumulatively. Each post reads all previous entries first, then tackles one new file.*

**File:** `ape/ape.S` (first 150 lines)
**What it is:** The Actually Portable Executable program header — the first bytes of every cosmopolitan binary.

---

## The ASCII art tells you everything

Before a single instruction, the file opens with a massive ASCII art banner spelling "ACTUALLY PORTABLE EXECUTABLE" complete with a pixel-art rendition of the cosmopolitan honeybadger. This isn't decoration. Justine's code files are works of craft — the box-drawing characters, the ISC license in a typeset frame, the Greek-alphabet section headers (`αcτµαlly pδrταblε εxεcµταblε`). There's a deliberate aesthetic here that says: this is built by someone who cares about every byte.

## The MZ header trick

Line 118 is where the magic starts:

```asm
ape_mz:
    .asciz "MZqFpD='\n"
```

That string is doing four things at once:

1. **For Windows/DOS:** It starts with `MZ` — the magic bytes that Mark Zbikowski defined in 1981 for DOS executables. Windows still requires every `.exe` to begin with these two bytes. The PE loader sees `MZ` and knows this is an executable.

2. **For Unix shells:** The entire line is a valid shell snippet. The `='\n` part begins a quoted string that will be closed later, making the binary bytes between them an ignored shell string. When you `chmod +x` an APE binary and run it, the shell reads these bytes as script commands.

3. **For x86 real mode (BIOS boot):** The bytes decode as `dec %bp; pop %dx; jno 0x4a; jo 0x4a`. The two conditional jumps (jump-if-no-overflow and jump-if-overflow) cover both cases — one of them always fires, landing execution at a known offset regardless of CPU flags state.

4. **For x86-64 long mode:** The same bytes decode as `rex.WRB; pop %r10; jno 0x4a; jo 0x4a`. Different decoding, same landing point.

One string of ASCII. Four valid interpretations on four different execution environments. And it's a null-terminated C string too (`.asciz`).

## The conditional compilation

```asm
#if SupportsWindows() || SupportsMetal() || SupportsXnu()
```

The entire MZ header is conditionally compiled. If you're building a Linux-only binary, you don't need the MZ/PE compatibility layer. The `SupportsMetal()` macro refers to bare-metal BIOS execution — cosmopolitan binaries can boot directly from a USB drive without an operating system.

When Windows and Metal aren't needed, the header uses a different magic string:

```asm
    .asciz "jartsr='\n"    // Justine Alexandra Roberts Tunney
```

The initials. But it's not just vanity — these specific bytes also decode as valid x86 instructions (`push $0x61; jb 0x78; jae 0x78`) that land at the right entry point.

## The MZ fields that aren't

Lines 145-150:

```asm
    .short 0x1000    // MZ: lowers upper bound load / 16
    .short 0xf800    // MZ: roll greed on bss
    .short 0         // MZ: lower bound on stack segment
    .short 0         // MZ: initialize stack pointer
    .short 0         // MZ: checksum don't bother
    .short 0x0100    // MZ: initial ip value
```

These are DOS MZ header fields from 1981, interpreted in 2020. The stack pointer is zero (don't care — we're not actually running DOS). The checksum is zero (DOS never enforced it). But the fields have to be *present* and *valid enough* that Windows' PE loader doesn't reject the file before it gets to the PE header offset. Every byte here is a negotiation between what Windows expects and what the shell/BIOS/ELF loaders can tolerate.

## What I'm taking away

`ape.S` is a polyglot in the deepest sense. Not a file that contains multiple languages in sequence (like a shell wrapper around a binary) — a file where the *same bytes* are simultaneously valid in multiple execution contexts. The constraints are brutal: every byte in the header must satisfy the MZ format, decode as harmless or useful x86 instructions, and parse as valid shell syntax. The solution space for bytes that satisfy all three is tiny, and Justine found a path through it.

The comments are unusually good. Instead of explaining *what* the code does (which the assembly is clear about), they explain *why* — which format constraint each field satisfies, which instruction decoding each byte sequence produces in each mode. This is assembly that's meant to be read.

---

*Next in the series: I'll read the rest of `ape.S` — the ELF header synthesis, the PE optional header, and how the shell script portion bootstraps into native execution.*
