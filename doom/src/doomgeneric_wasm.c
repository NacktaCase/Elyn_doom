// doomgeneric 플랫폼 계층 — Elyn 샌드박스(브라우저 WASM) 판.
//
// doomgeneric 이 요구하는 함수는 6개뿐이다(doomgeneric.h). 나머지는 전부
// 바닐라 DOOM 코드 그대로다 — vendor/ 는 한 줄도 고치지 않는다.
//
// ── 설계 방침: chess3d/engine-rs 와 같다 ─────────────────────────────
// wasm-bindgen 도 Emscripten 도 쓰지 않는다. 이유가 둘인데, 두 번째가
// 이 프로젝트에 고유하다:
//
//   1. Elyn 컴포넌트는 function 하나 안에 다 들어가야 해서 glue 모듈을
//      import 할 수 없다 (ChessEngine.jsx 가 같은 이유로 날것 export 를 쓴다).
//   2. **Elyn 은 컴포넌트 소스를 정적 스캔해 등록을 막는다.** 정찰본 v1.0 이
//      실제로 그렇게 거부됐다. Emscripten glue 에는 네트워크·URL·파일 계열
//      이름이 수십 개 박혀 있어 그대로는 등록조차 안 될 공산이 크다.
//      glue 가 없으면 걸릴 이름이 애초에 안 생긴다.
//
// 그래서 export 는 #[no_mangle] 격인 __attribute__((export_name(...))) 로
// 날것으로 내보내고, JS 는 WebAssembly.instantiate(bytes).exports.* 로
// 직접 부른다.
//
// ── JS 가 부르는 것 / JS 가 주는 것 ─────────────────────────────────
//   JS → wasm :  doom_init / doom_tick / doom_key / doom_frame_ptr ...
//   wasm → JS :  js_now_ms()  하나뿐이다.
//
// import 가 하나라는 게 중요하다. ChessEngine 의 should_stop 과 같은 모양이고,
// import 표면이 좁을수록 브라우저 쪽 shim 이 작아진다.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "doomgeneric.h"
#include "doomkeys.h"
#include "i_system.h"   // I_AtExit
#include "g_game.h"     // G_CheckDemoStatus

// ── JS 가 제공하는 시계 ──────────────────────────────────────────────
// WASI 의 clock_time_get 을 쓸 수도 있지만 JS 에서 직접 받는다.
// ChessEngine 이 시계를 능력 탐지해 넘겨주는 것과 같은 방침 — 시간의 출처를
// **하나로** 두어야 나중에 "게임 시간이 어긋난다" 류의 사고가 안 난다.
__attribute__((import_module("env"), import_name("js_now_ms")))
extern uint32_t js_now_ms(void);

// ── 키 큐 ────────────────────────────────────────────────────────────
// doomgeneric 의 다른 플랫폼 구현과 같은 링 버퍼다(doomgeneric_win.c 참조).
//
// ⚠ 브라우저 코드 → DOOM 키코드 변환은 **JS 쪽에서** 한다. 여기서 하지 않는다.
//   변환표는 자판 배열·브라우저·모바일 IME 를 겪으며 계속 고쳐질 물건인데,
//   C 에 두면 고칠 때마다 wasm 을 다시 빌드해 base64 를 다시 주입해야 한다.
//   JS 에 두면 컴포넌트만 고치면 된다. (정찰 결과 e.code 가 165/165 로
//   전부 오므로 스캔코드 기반 변환이 가능하다 — 한글 입력 상태에서도
//   WASD 가 물리 위치로 동작한다.)
#define KEYQUEUE_SIZE 16
static uint16_t s_KeyQueue[KEYQUEUE_SIZE];
static unsigned int s_KeyQueueWriteIndex = 0;
static unsigned int s_KeyQueueReadIndex = 0;

// ── doomgeneric 이 요구하는 6개 ─────────────────────────────────────

// ── vendor 의 잠복 버그 우회: 종료 함수 시그니처 ────────────────────
// d_main.c:1513 이 이렇게 등록한다:
//     I_AtExit((atexit_func_t) G_CheckDemoStatus, true);
// 그런데 G_CheckDemoStatus 는 **boolean 을 반환한다.** atexit_func_t 는
// void(*)(void) 라 타입이 안 맞는데, 네이티브에서는 반환값만 버려지고 넘어간다.
//
// **wasm 은 간접 호출에서 시그니처를 검사한다.** 그래서 종료 함수 목록이
// 도는 순간 `function signature mismatch` 로 트랩한다 — 게임을 나갈 때든
// I_Error 로 죽을 때든 **반드시**. 실기에서 "나가면 오류" 가 이것이었고,
// 스프라이트 사고 때 원인 대신 이 문구만 보였던 것도 같은 이유다.
//
// vendor 를 고치지 않고 푼다: d_main.c 만 `-DG_CheckDemoStatus=<이 래퍼>` 로
// 컴파일해 **주소를 이 void 함수로** 잡게 한다(tools/build-doom-wasm.cjs).
// d_main.c 는 그 이름을 그 한 줄에서만 쓰므로 부작용이 없다.
void DoomWasm_CheckDemoStatus(void) { G_CheckDemoStatus(); }

// ── 종료 감지 ────────────────────────────────────────────────────────
// **doomgeneric 의 I_Quit 은 프로세스를 끝내지 않는다.** 원본의 exit(0) 이
// `#if ORIGCODE` 안에 들어 있어 컴파일되지 않는다(i_system.c). 그래서 메뉴에서
// 게임을 끝내면 종료 함수들(S_Shutdown, I_ShutdownGraphics …)만 돌고 **그대로
// 리턴**하고, 게임은 해체된 상태로 계속 틱을 돌다 다음 틱에서 터진다.
// 실기에서 "게임을 나가면 오류가 뜬다"가 정확히 이것이었다.
//
// 우리 종료 함수를 하나 끼워 그 순간을 붙잡는다. I_Quit 은 등록된 것을 전부
// 돌리므로 순서와 무관하게 반드시 불린다. 그 뒤로 doom_tick 은 아무것도 하지
// 않고, JS 는 doom_exited() 를 보고 루프를 멈추고 "종료됨" 을 그린다.
static int s_exited = 0;

// ⚠ **플래그만 세우면 부족하다.** I_Quit 은 종료 함수들을 돌린 뒤 리턴하고,
//   그 **같은 틱 안에서** 나머지 코드(G_Ticker, S_UpdateSounds …)가 계속
//   돈다. 사운드는 이미 S_Shutdown 으로 해제됐으므로 거기서 터진다.
//   실기에서 "게임을 나가면 오류" 가 정확히 이것이었고, 브라우저에서
//   `function signature mismatch` 로 재현했다.
//
//   그래서 여기서 **돌아가지 않는다.** _Exit 은 WASI proc_exit 을 부르고,
//   우리 shim 이 그걸 예외로 던져 wasm 호출 스택 전체가 풀린다. JS 는
//   그 예외의 코드가 0 인지 보고 "정상 종료" 로 처리한다.
//
//   run_on_error=false 로 등록하므로 I_Error 경로에서는 불리지 않는다.
//   그쪽은 I_Error 가 스스로 exit(-1) 을 부르고(i_system.c), 코드가 0 이
//   아니라 JS 가 오류로 가른다.
//
//   등록 시점이 doomgeneric_Create 안(=가장 이르다)이라 종료 함수 스택에서
//   **맨 마지막에** 불린다. 다른 셧다운은 전부 끝난 뒤다.
static void OnDoomExit(void)
{
    s_exited = 1;
    _Exit(0);
}

void DG_Init(void)
{
    // 화면 버퍼는 doomgeneric_Create 가 잡고, 그 뒤로는 JS 가
    // doom_frame_ptr() 로 주소를 받아 직접 읽는다. 여기서 할 일은 이것뿐이다.
    I_AtExit(OnDoomExit, false);   // false = 정상 종료에서만. 위 주석 참조
}

void DG_DrawFrame(void)
{
    // 여기서 아무것도 하지 않는다. 프레임을 **밀어내지 않고**, JS 가
    // rAF 안에서 doom_tick() 을 부른 뒤 화면 버퍼를 당겨간다.
    //
    // 밀어내는 쪽(여기서 JS 콜백 호출)으로 만들면 wasm→JS→canvas 호출이
    // 틱 안쪽에 끼어 프레임 예산을 우리가 못 쥔다. 당겨가는 쪽이면 JS 가
    // 언제 몇 번 그릴지 정할 수 있다.
}

void DG_SleepMs(uint32_t ms)
{
    // **반드시 no-op 이어야 한다.** 브라우저 메인스레드는 잠들면 안 된다.
    // 여기서 바쁜 대기를 돌면 화면이 통째로 얼어붙는다.
    // 페이싱은 JS 의 rAF 가 쥔다.
    (void)ms;
}

uint32_t DG_GetTicksMs(void)
{
    return js_now_ms();
}

int DG_GetKey(int *pressed, unsigned char *doomKey)
{
    if (s_KeyQueueReadIndex == s_KeyQueueWriteIndex) return 0;   // 큐가 비었다

    uint16_t keyData = s_KeyQueue[s_KeyQueueReadIndex];
    s_KeyQueueReadIndex = (s_KeyQueueReadIndex + 1) % KEYQUEUE_SIZE;

    *pressed = keyData >> 8;
    *doomKey = keyData & 0xFF;
    return 1;
}

void DG_SetWindowTitle(const char *title)
{
    (void)title;   // 채팅창 안이라 제목을 걸 자리가 없다
}

// ── libc 구멍 메우기 ────────────────────────────────────────────────
// WASI 에는 프로세스 실행이 없어 system() 이 없다. i_system.c 가 두 곳에서
// 쓰는데 둘 다 **zenity 에러 대화상자**용이다(i_system.c:274, :342) —
// 브라우저에서는 애초에 의미가 없다.
//
// 0 이 아닌 값을 돌려주면 DOOM 은 "zenity 가 없다"로 보고 평범한 stderr
// 경로로 떨어진다. 그게 우리가 원하는 동작이다.
//
// ⚠ 이걸 "빌드를 통과시키려고 넣은 가짜"로 보면 안 된다. 진짜로 없는 기능이고,
//   DOOM 쪽에 이미 없을 때의 경로가 있다.
int system(const char *cmd)
{
    (void)cmd;
    return -1;
}

// ── JS 가 부르는 export ──────────────────────────────────────────────

// WAD 를 담을 자리를 잡는다. JS 가 반환된 주소에 압축 해제한 바이트를 쓴다.
// (정찰 결과 DecompressionStream 이 gzip·deflate-raw 를 둘 다 푼다 —
//  inflate 를 직접 실을 필요가 없다.)
static unsigned char *s_wad = NULL;
static uint32_t s_wadLen = 0;

__attribute__((export_name("doom_wad_alloc")))
unsigned char *doom_wad_alloc(uint32_t len)
{
    if (s_wad) free(s_wad);
    s_wad = (unsigned char *)malloc(len);
    s_wadLen = s_wad ? len : 0;
    return s_wad;
}

// w_file_memory.c 가 이 둘을 읽는다. 헤더를 새로 만들지 않고 extern 으로
// 잇는다 — vendor 트리에 우리 헤더를 끼워넣지 않으려는 것이다.
unsigned char *doom_wad_data(void) { return s_wad; }
uint32_t doom_wad_size(void) { return s_wadLen; }

__attribute__((export_name("doom_init")))
int doom_init(void)
{
    // argv 는 정적으로 둔다. myargv 가 이 포인터를 **계속 들고 있으므로**
    // 스택에 두면 안 된다 (doomgeneric.c 가 myargv = argv 로 저장만 한다).
    static char a0[] = "doom";
    static char a1[] = "-iwad";
    static char a2[] = "doom.wad";
    static char *argv[] = { a0, a1, a2, NULL };

    // ⚠ **-warp 를 주지 말 것.** 한때 `-warp 1 1 -skill 3` 으로 곧장 E1M1 에
    //   들어가게 했다. 채팅창에서 바로 플레이하는 게 친절해 보였지만 두 가지가
    //   나빴다:
    //
    //   1. **라이선스.** 셰어웨어는 정품 구매를 유도하는 게 존재 이유이고,
    //      타이틀 화면·데모·주문 안내(HELP1/HELP2)가 그 역할을 한다.
    //      "완전하고 변형되지 않은 배포"를 파일 바이트로만 좁게 읽지 않는 편이
    //      안전하다 — 건너뛰면 그 안내가 플레이어에게 도달하지 않는다.
    //   2. **원래 게임이 아니다.** DOOM 은 타이틀 → 데모 → 메뉴로 시작한다.
    //
    //   -warp 가 없으면 autostart 가 안 서고 D_DoomMain 이 D_StartTitle() 로
    //   간다(d_main.c:1837). 타이틀·데모·엔딩 럼프는 셰어웨어 WAD 를 통째로
    //   싣고 있으므로 전부 들어 있다.
    doomgeneric_Create(3, argv);
    return 1;
}



__attribute__((export_name("doom_tick")))
void doom_tick(void)
{
    // 종료 뒤에는 아무것도 하지 않는다. 사운드·그래픽이 이미 해체돼 있어
    // 한 번만 더 돌아도 해제된 메모리를 밟는다.
    if (s_exited) return;
    doomgeneric_Tick();
}

// JS 가 매 프레임 확인한다. 1 이면 루프를 멈추고 "종료됨" 을 그린다.
__attribute__((export_name("doom_exited")))
int doom_exited(void) { return s_exited; }

// 시험용. 레벨을 끝내 **인터미션을 거쳐** 다음 판으로 가게 한다.
// IDCLEV 치트는 인터미션을 건너뛰므로 정상 진행 경로를 재현하지 못한다.
// 컴포넌트는 이걸 부르지 않는다 — tools/doom-warp-test.cjs 전용이다.
__attribute__((export_name("doom_exit_level")))
void doom_exit_level(void) { G_ExitLevel(); }

__attribute__((export_name("doom_key")))
void doom_key(int pressed, int doomKey)
{
    s_KeyQueue[s_KeyQueueWriteIndex] = (uint16_t)((pressed << 8) | (doomKey & 0xFF));
    s_KeyQueueWriteIndex = (s_KeyQueueWriteIndex + 1) % KEYQUEUE_SIZE;
}

// 화면 버퍼 주소. doomgeneric_Create 가 malloc 하므로 **doom_init 뒤에**
// 물어야 한다. 그 전에는 NULL 이다.
__attribute__((export_name("doom_frame_ptr")))
uint32_t doom_frame_ptr(void) { return (uint32_t)(uintptr_t)DG_ScreenBuffer; }

__attribute__((export_name("doom_width")))  int doom_width(void)  { return DOOMGENERIC_RESX; }
__attribute__((export_name("doom_height"))) int doom_height(void) { return DOOMGENERIC_RESY; }
