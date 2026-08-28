// chocolate-doom 에서 들여온 OPL 음악 소스를 doomgeneric 헤더와 맞추는 어댑터.
//
// **이 파일은 vendor 소스를 고치지 않으려고 존재한다.** 빌드에서
// `-include opl_compat.h` 로 OPL 쪽 파일에만 강제로 끼운다
// (tools/build-doom-wasm.cjs). doomgeneric 쪽 파일에는 안 끼운다.
//
// doomgeneric 은 chocolate-doom 의 옛 판본을 잘라 만든 것이라 헤더가 조금
// 어긋난다. 어긋나는 지점이 정확히 둘이다.
#ifndef DOOM_OPL_COMPAT_H
#define DOOM_OPL_COMPAT_H

#include "doomtype.h"

// ── 1. PACKED_STRUCT ─────────────────────────────────────────────────
// doomgeneric 의 doomtype.h 에는 `PACKEDATTR` 만 있고 `PACKED_STRUCT` 가 없다.
// chocolate 쪽 midifile.c / i_oplmusic.c 는 후자를 쓴다.
// WAD·MIDI 구조체를 파일 바이트에 그대로 겹쳐 읽으므로 **패킹은 필수다** —
// 빼먹으면 정렬 때문에 필드가 밀려 악기 정의가 통째로 깨진다.
#ifndef PACKED_STRUCT
#define PACKED_STRUCT(...) struct __VA_ARGS__ PACKEDATTR
#endif

// ── 2. 헤더 우선순위로 푸는 것 (여기서 안 한다) ─────────────────────
// doomgeneric 의 i_sound.h 는 `music_opl_module` 을 non-const 로 선언하는데
// chocolate 의 i_oplmusic.c 는 const 로 정의한다. 매크로로 이름을 바꿔
// 피하려다 실패했다 — 매크로는 헤더의 선언까지 같이 바꿔버려 충돌이 그대로였다.
//
// 대신 **OPL 소스에만 chocolate 의 i_sound.h 를 먼저 보이게** 한다
// (`-I doom/vendor/opl` 을 `-I .../doomgeneric` 앞에 둔다). 거기엔
// `extern const music_module_t music_opl_module;` 과 `opl_driver_ver_t` 가
// 함께 들어 있어 둘 다 한 번에 풀린다.
//
// ⚠ 이래도 되는 근거: 두 헤더의 `music_module_t` **레이아웃이 동일하다**
//   (첫 필드의 const 한정자만 다르고 배치는 같다 — 대조했다). 다르면
//   한쪽은 chocolate 레이아웃으로, 다른 쪽은 doomgeneric 레이아웃으로
//   컴파일되어 **조용히 깨진다.** 헤더를 갱신하면 반드시 다시 대조할 것.

// ── 4. midifile.c 가 쓰는 SDL·chocolate 헬퍼 ─────────────────────────
// MIDI 파일은 **빅엔디언**이고 wasm 은 리틀엔디언이라 뒤집어야 한다.
// chocolate 는 SDL 의 것을 쓰지만 우리에겐 SDL 이 없다. 하는 일이 바이트
// 뒤집기뿐이라 여기서 직접 준다.
#include <stdlib.h>
#include <stdint.h>

static inline uint16_t OplCompat_SwapBE16(uint16_t v)
{
    return (uint16_t) ((v << 8) | (v >> 8));
}

static inline uint32_t OplCompat_SwapBE32(uint32_t v)
{
    return ((v & 0x000000ffu) << 24) | ((v & 0x0000ff00u) << 8)
         | ((v & 0x00ff0000u) >> 8)  | ((v & 0xff000000u) >> 24);
}

#define SDL_SwapBE16(x) OplCompat_SwapBE16((uint16_t)(x))
#define SDL_SwapBE32(x) OplCompat_SwapBE32((uint32_t)(x))

// chocolate 의 m_misc.c 에 있는 realloc 래퍼. doomgeneric 엔 없다.
// 실패를 조용히 넘기면 곧바로 널 역참조가 되므로 그냥 NULL 을 돌려주고
// 호출부가 판단하게 둔다(midifile.c 가 확인한다).
static inline void *OplCompat_Realloc(void *ptr, size_t size)
{
    return realloc(ptr, size);
}

#define I_Realloc(p, n) OplCompat_Realloc((p), (n))

// chocolate 은 윈도우에서 UTF-8 경로를 다루려고 fopen/remove 를 감싼다.
// 우리 파일시스템은 WASI shim 의 껍데기라 감쌀 것이 없다(doom/src/wasi-shim.js).
#include <stdio.h>
#define M_fopen(path, mode) fopen((path), (mode))
#define M_remove(path)      remove((path))

#endif
