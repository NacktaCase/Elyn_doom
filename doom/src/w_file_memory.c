// WAD 를 메모리에서 읽는 백엔드. w_file_stdc.c 를 **대체한다.**
//
// ── 왜 파일시스템을 흉내내지 않는가 ─────────────────────────────────
// 브라우저에는 파일이 없다. 방법이 둘이었다:
//   (a) JS 에 WASI 파일시스템 shim 을 짜서 path_open/fd_read/fd_seek 를
//       흉내낸다. DOOM 코드는 손 안 대도 되지만 shim 이 커지고, WAD 읽기가
//       매번 wasm→JS 왕복이 된다.
//   (b) WAD 백엔드만 갈아끼운다.
//
// (b) 를 골랐다. w_file.h 의 백엔드가 **함수 3개짜리 vtable** 이라 갈아끼우는
// 비용이 이 파일 하나뿐이고, w_file.c 가 `extern wad_file_class_t stdc_wad_file`
// 을 이름으로 찾으므로 **같은 심볼 이름을 쓰면 vendor 트리를 한 줄도 안 고쳐도
// 된다.** 빌드에서 w_file_stdc.c 를 빼고 이 파일을 넣으면 끝이다.
//
// ── mapped 를 채우는 게 핵심이다 ────────────────────────────────────
// wad_file_t 에는 `mapped` 필드가 있다. NULL 이 아니면 DOOM 은 그 포인터를
// 직접 읽고 Read() 를 부르지 않는다(W_CacheLumpNum). WAD 가 이미 선형 메모리에
// 통째로 있으므로 여기에 그대로 물려주면 **럼프 읽기가 전부 zero-copy** 가 된다.
// 파일 백엔드에서는 불가능한 이점이고, 우리 쪽에서는 공짜다.
#include <stdint.h>
#include <string.h>

#include "w_file.h"
#include "z_zone.h"

// doomgeneric_wasm.c 가 들고 있는 WAD. 헤더를 새로 만들지 않고 extern 으로
// 잇는다 — vendor 트리에 우리 헤더를 끼워넣지 않으려는 것이다.
extern unsigned char *doom_wad_data(void);
extern uint32_t doom_wad_size(void);

// ⚠ 이름을 바꾸지 말 것. w_file.c 가 이 심볼을 찾는다(w_file.c:28).
//   이름을 바꾸면 vendor 를 고쳐야 하고, 그 순간 "루트는 안 고친다" 가 깨진다.
extern wad_file_class_t stdc_wad_file;

typedef struct {
    wad_file_t wad;
} mem_wad_file_t;

static wad_file_t *W_Mem_OpenFile(char *path)
{
    // **path 를 무시한다.** WAD 가 하나뿐이고 JS 가 이미 실어놨다.
    // d_iwad 가 어떤 이름으로 찾든 같은 것을 돌려준다.
    (void)path;

    unsigned char *data = doom_wad_data();
    uint32_t len = doom_wad_size();
    if (data == NULL || len == 0) return NULL;   // 아직 안 실렸다

    mem_wad_file_t *result = Z_Malloc(sizeof(mem_wad_file_t), PU_STATIC, 0);
    result->wad.file_class = &stdc_wad_file;
    result->wad.mapped = (byte *)data;   // ← 이것 때문에 럼프 읽기가 zero-copy 다
    result->wad.length = len;
    return &result->wad;
}

static void W_Mem_CloseFile(wad_file_t *wad)
{
    // WAD 바이트 자체는 doomgeneric_wasm.c 소유다. 여기서 해제하지 않는다 —
    // 해제하면 mapped 를 들고 있는 럼프 포인터가 전부 dangling 이 된다.
    Z_Free(wad);
}

static size_t W_Mem_Read(wad_file_t *wad, unsigned int offset,
                         void *buffer, size_t buffer_len)
{
    unsigned char *data = doom_wad_data();
    if (data == NULL) return 0;

    // 범위를 잘라낸다. WAD 가 잘려 있거나 디렉터리가 깨져 있으면 DOOM 이
    // 파일 끝 너머를 읽으려 드는데, 파일 백엔드에서는 fread 가 짧게 읽고
    // 끝나지만 메모리에서는 **선형 메모리를 넘겨 읽는다.** 여기서 막는다.
    uint32_t len = doom_wad_size();
    if (offset >= len) return 0;
    size_t avail = (size_t)(len - offset);
    if (buffer_len > avail) buffer_len = avail;

    memcpy(buffer, data + offset, buffer_len);
    return buffer_len;
}

wad_file_class_t stdc_wad_file =
{
    W_Mem_OpenFile,
    W_Mem_CloseFile,
    W_Mem_Read,
};
