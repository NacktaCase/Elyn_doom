// OPL2/3 백엔드 — chocolate-doom 의 opl/opl.c + opl/opl_sdl.c 를 **대체한다.**
//
// ── 왜 대체인가 ──────────────────────────────────────────────────────
// 원본 둘 다 그대로는 못 쓴다:
//
//   · `opl.c` 의 `OPL_Delay()` 는 SDL 뮤텍스/조건변수로 **블로킹한다.**
//     콜백이 오디오 스레드에서 시간을 밀어주길 기다리는 구조인데, 우리는
//     단일 스레드고 시간은 JS 가 샘플을 당겨갈 때만 흐른다 → 영원히 멈춘다.
//     그리고 `OPL_Detect()` 가 그 Delay 를 부른다.
//   · `opl.c` 의 드라이버 목록 `drivers[]` 는 linux/win32/sdl 로 하드코딩돼
//     있어 우리 드라이버를 끼울 자리가 없다.
//   · `opl_sdl.c` 는 SDL_mixer 로 오디오 장치를 연다. 브라우저엔 없다.
//
// 그래서 공개 API(opl.h) 16개를 여기서 직접 구현한다. 에뮬레이터 자체
// (`opl3.c`)와 콜백 큐(`opl_queue.c`)는 **원본을 그대로 컴파일해 쓴다** —
// 소리를 만드는 부분은 우리가 손댈 이유가 없다.
//
// i_sound_wasm.c 가 i_sound.c 를 대체하는 것과 같은 방침이고, vendor 트리는
// 여전히 한 줄도 안 고친다.
//
// ── 시간이 흐르는 방식 ───────────────────────────────────────────────
// SDL 판은 오디오 콜백이 시간을 민다. 우리는 **JS 가 당겨갈 때** 민다:
//     doom_music_fill() → OPL_Wasm_FillBuffer() → 샘플 생성 + 콜백 실행
// 그래서 음악이 재생되지 않으면 OPL 시간도 멈춘다. 그게 맞다 —
// 음악은 오디오 출력에 종속된 것이지 게임 시계에 매인 게 아니다.
#include <stdint.h>
#include <string.h>

#include "doomtype.h"
#include "opl.h"
#include "opl_queue.h"
#include "opl3.h"

// chocolate-doom 의 i_sound.c 가 내보내던 것. i_oplmusic.c 가 쓴다.
// (opl_io_port 는 정의하지 않는다 — 이 판본의 i_oplmusic.c 가 직접 갖고 있어
//  둘 다 정의하면 중복 심볼로 링크가 깨진다.)
unsigned int opl_sample_rate = 44100;

// ── 상태 ─────────────────────────────────────────────────────────────
static opl3_chip opl_chip;
static int opl_opl3mode;
static unsigned int mixing_freq = 44100;
static opl_callback_queue_t *callback_queue = NULL;
static uint64_t current_time;
static uint64_t pause_offset;
static int opl_paused;
static unsigned int register_num = 0;
static int init_stage_reg_writes = 1;
static int initialised = 0;

// 타이머 두 개. 레이트는 원본과 같다(12.5kHz / 3.125kHz).
typedef struct {
    unsigned int rate;
    unsigned int enabled;
    unsigned int value;
    uint64_t expire_time;
} opl_timer_t;

static opl_timer_t timer1 = { 12500, 0, 0, 0 };
static opl_timer_t timer2 = { 3125, 0, 0, 0 };

// ── 타이머 (opl_sdl.c 와 같은 규칙) ──────────────────────────────────
static void CalculateEndTime(opl_timer_t *timer)
{
    if (timer->enabled)
    {
        int tics = 0x100 - timer->value;
        timer->expire_time = current_time + ((uint64_t) tics * OPL_SECOND) / timer->rate;
    }
}

static void WriteChipRegister(unsigned int reg_num, unsigned int value)
{
    switch (reg_num)
    {
        case OPL_REG_TIMER1:
            timer1.value = value;
            CalculateEndTime(&timer1);
            break;

        case OPL_REG_TIMER2:
            timer2.value = value;
            CalculateEndTime(&timer2);
            break;

        case OPL_REG_TIMER_CTRL:
            if (value & 0x80)
            {
                timer1.enabled = 0;
                timer2.enabled = 0;
            }
            else
            {
                if ((value & 0x40) == 0)
                {
                    timer1.enabled = (value & 0x01) != 0;
                    CalculateEndTime(&timer1);
                }
                if ((value & 0x20) == 0)
                {
                    timer2.enabled = (value & 0x02) != 0;
                    CalculateEndTime(&timer2);
                }
            }
            break;

        case OPL_REG_NEW:
            opl_opl3mode = value & 0x01;
            /* fallthrough — 원본도 여기서 안 끊는다 */

        default:
            OPL3_WriteRegBuffered(&opl_chip, reg_num, value);
            break;
    }
}

// ── 공개 API ─────────────────────────────────────────────────────────

opl_init_result_t OPL_Init(unsigned int port_base)
{
    (void)port_base;
    if (callback_queue == NULL) callback_queue = OPL_Queue_Create();
    else OPL_Queue_Clear(callback_queue);

    current_time = 0;
    pause_offset = 0;
    opl_paused = 0;
    register_num = 0;
    init_stage_reg_writes = 1;
    mixing_freq = opl_sample_rate;

    OPL3_Reset(&opl_chip, mixing_freq);
    initialised = 1;

    // **탐지 절차를 돌리지 않는다.** 원본은 타이머를 걸어놓고 시간이
    // 흐르기를 기다려 칩 유무를 확인하는데, 우리 시간은 오디오를 당겨갈
    // 때만 흐르므로 그 자리에서 멈춘다. 그리고 애초에 우리가 칩을 들고
    // 있으니 물어볼 이유가 없다.
    return OPL_INIT_OPL3;
}

void OPL_Shutdown(void)
{
    if (callback_queue != NULL)
    {
        OPL_Queue_Destroy(callback_queue);
        callback_queue = NULL;
    }
    initialised = 0;
}

void OPL_SetSampleRate(unsigned int rate)
{
    if (rate > 0) opl_sample_rate = rate;
}

void OPL_WritePort(opl_port_t port, unsigned int value)
{
    if (port == OPL_REGISTER_PORT) register_num = value;
    else if (port == OPL_REGISTER_PORT_OPL3) register_num = value | 0x100;
    else if (port == OPL_DATA_PORT) WriteChipRegister(register_num, value);
}

unsigned int OPL_ReadPort(opl_port_t port)
{
    unsigned int result = 0;

    if (port == OPL_REGISTER_PORT_OPL3) return 0xff;

    if (timer1.enabled && current_time > timer1.expire_time)
    {
        result |= 0x80;   // 둘 중 하나가 만료됨
        result |= 0x40;   // 타이머 1
    }
    if (timer2.enabled && current_time > timer2.expire_time)
    {
        result |= 0x80;
        result |= 0x20;   // 타이머 2
    }
    return result;
}

unsigned int OPL_ReadStatus(void)
{
    return OPL_ReadPort(OPL_REGISTER_PORT);
}

// ⚠ 아래 둘은 chocolate-doom 의 opl.c 에서 **그대로 옮겼다.** 고치지 말 것.
//   레지스터를 쓰는 순서와 사이사이의 더미 읽기 횟수가 DOOM 원본 코드의
//   타이밍을 흉내내는 것이라, 줄이면 악기 음색이 달라진다.
//   (존재하지 않는 레지스터에 쓰는 루프와 `<=` 도 원본 그대로다 —
//    DOOM 이 그렇게 했기 때문이다.)
void OPL_WriteRegister(int reg, int value)
{
    int i;

    if (reg & 0x100) OPL_WritePort(OPL_REGISTER_PORT_OPL3, reg);
    else OPL_WritePort(OPL_REGISTER_PORT, reg);

    for (i = 0; i < 6; ++i)
    {
        if (init_stage_reg_writes) OPL_ReadPort(OPL_REGISTER_PORT);
        else OPL_ReadPort(OPL_DATA_PORT);
    }

    OPL_WritePort(OPL_DATA_PORT, value);

    for (i = 0; i < 24; ++i) OPL_ReadStatus();
}

void OPL_InitRegisters(int opl3)
{
    int r;

    for (r = OPL_REGS_LEVEL; r <= OPL_REGS_LEVEL + OPL_NUM_OPERATORS; ++r)
        OPL_WriteRegister(r, 0x3f);

    for (r = OPL_REGS_ATTACK; r <= OPL_REGS_WAVEFORM + OPL_NUM_OPERATORS; ++r)
        OPL_WriteRegister(r, 0x00);

    for (r = 1; r < OPL_REGS_LEVEL; ++r)
        OPL_WriteRegister(r, 0x00);

    OPL_WriteRegister(OPL_REG_TIMER_CTRL, 0x60);
    OPL_WriteRegister(OPL_REG_TIMER_CTRL, 0x80);
    OPL_WriteRegister(OPL_REG_WAVEFORM_ENABLE, 0x20);

    if (opl3)
    {
        OPL_WriteRegister(OPL_REG_NEW, 0x01);

        for (r = OPL_REGS_LEVEL; r <= OPL_REGS_LEVEL + OPL_NUM_OPERATORS; ++r)
            OPL_WriteRegister(r | 0x100, 0x3f);

        for (r = OPL_REGS_ATTACK; r <= OPL_REGS_WAVEFORM + OPL_NUM_OPERATORS; ++r)
            OPL_WriteRegister(r | 0x100, 0x00);

        for (r = 1; r < OPL_REGS_LEVEL; ++r)
            OPL_WriteRegister(r | 0x100, 0x00);
    }

    OPL_WriteRegister(OPL_REG_FM_MODE, 0x40);

    if (opl3) OPL_WriteRegister(OPL_REG_NEW, 0x01);

    // 여기부터는 초기화가 아니므로 더미 읽기 대상이 데이터 포트로 바뀐다.
    init_stage_reg_writes = 0;
}

opl_init_result_t OPL_Detect(void)
{
    return OPL_INIT_OPL3;   // 위 OPL_Init 주석 참조
}

void OPL_SetCallback(uint64_t us, opl_callback_t callback, void *data)
{
    if (callback_queue == NULL) return;
    OPL_Queue_Push(callback_queue, callback, data, current_time - pause_offset + us);
}

void OPL_ClearCallbacks(void)
{
    if (callback_queue != NULL) OPL_Queue_Clear(callback_queue);
}

void OPL_AdjustCallbacks(float factor)
{
    if (callback_queue != NULL) OPL_Queue_AdjustCallbacks(callback_queue, current_time, factor);
}

// 단일 스레드다. 잠글 것이 없다.
void OPL_Lock(void) { }
void OPL_Unlock(void) { }

void OPL_SetPaused(int paused) { opl_paused = paused; }

// ⚠ 원본은 여기서 오디오 스레드가 시간을 밀어줄 때까지 **블로킹한다.**
//   우리는 그럴 수 없으므로 시간을 **직접 밀고** 그 사이의 콜백을 실행한다.
//   i_oplmusic 은 초기화 중에만 이걸 부르므로 이렇게 해도 음악 타이밍에
//   영향이 없다.
static void AdvanceTime(unsigned int nsamples);

void OPL_Delay(uint64_t us)
{
    if (!initialised || us == 0) return;
    // 마이크로초를 샘플 수로 바꿔 시간을 민다.
    uint64_t nsamples = (us * mixing_freq + OPL_SECOND - 1) / OPL_SECOND;
    while (nsamples > 0)
    {
        unsigned int step = nsamples > 1024 ? 1024 : (unsigned int) nsamples;
        AdvanceTime(step);
        nsamples -= step;
    }
}

// ── 시간 진행 + 콜백 (opl_sdl.c 의 AdvanceTime 과 같은 규칙) ─────────
static void AdvanceTime(unsigned int nsamples)
{
    opl_callback_t callback;
    void *callback_data;
    uint64_t us;

    us = ((uint64_t) nsamples * OPL_SECOND) / mixing_freq;
    current_time += us;

    if (opl_paused) pause_offset += us;

    while (callback_queue != NULL
        && !OPL_Queue_IsEmpty(callback_queue)
        && current_time >= OPL_Queue_Peek(callback_queue) + pause_offset)
    {
        if (!OPL_Queue_Pop(callback_queue, &callback, &callback_data)) break;
        callback(callback_data);
    }
}

// ── JS 가 당겨가는 입구 ──────────────────────────────────────────────
// 스테레오 인터리브 int16 을 nsamples 프레임만큼 채운다.
// 반환값은 실제로 채운 프레임 수다(항상 nsamples — 무음이라도 0 으로 채운다).
//
// **콜백을 실행하기 전까지 샘플을 만들지 않는다.** 다음 콜백 시각까지만
// 생성하고, 그 지점에서 콜백을 돌린 뒤 이어서 만든다. 그래야 음이 정확한
// 시점에 바뀐다 — 뭉텅이로 만들고 나중에 콜백을 몰아 실행하면 박자가 뭉갠다.
// 출력 버퍼는 여기서 들고 있는다. JS 가 주소를 넘기게 하면 그쪽에서
// malloc 을 관리해야 하고, 메모리가 grow 하면 주소가 아니라 **뷰가** 무효가
// 되는 함정까지 JS 로 옮겨간다. 여기 두는 편이 실수할 자리가 적다.
#define MUSIC_BUF_FRAMES 8192
static int16_t music_buf[MUSIC_BUF_FRAMES * 2];

__attribute__((export_name("doom_music_frames")))
int doom_music_frames(void) { return MUSIC_BUF_FRAMES; }

// nframes 프레임을 채우고 **버퍼 주소**를 돌려준다(스테레오 인터리브 int16).
// 못 채우면 0.
__attribute__((export_name("doom_music_fill")))
int doom_music_fill(int nsamples)
{
    int16_t *out = music_buf;
    unsigned int filled = 0;

    if (!initialised || nsamples <= 0) return 0;
    if (nsamples > MUSIC_BUF_FRAMES) nsamples = MUSIC_BUF_FRAMES;

    while (filled < (unsigned int) nsamples)
    {
        uint64_t chunk;

        if (opl_paused || callback_queue == NULL || OPL_Queue_IsEmpty(callback_queue))
        {
            chunk = (unsigned int) nsamples - filled;
        }
        else
        {
            uint64_t next = OPL_Queue_Peek(callback_queue) + pause_offset;
            uint64_t ahead = next > current_time ? next - current_time : 0;
            chunk = (ahead * mixing_freq + OPL_SECOND - 1) / OPL_SECOND;
            if (chunk > (unsigned int) nsamples - filled) chunk = (unsigned int) nsamples - filled;
            if (chunk == 0) chunk = 1;   // 콜백이 밀려 있으면 한 샘플씩 전진
        }

        OPL3_GenerateStream(&opl_chip, out + filled * 2, (uint32_t) chunk);
        filled += (unsigned int) chunk;
        AdvanceTime((unsigned int) chunk);
    }

    return (int) (uintptr_t) out;
}

// JS 가 오디오 컨텍스트의 실제 샘플레이트를 알려준다. **doom_init 전에**
// 불러야 한다 — OPL_Init 이 이 값으로 칩을 리셋하기 때문이다.
__attribute__((export_name("doom_music_set_rate")))
void doom_music_set_rate(int rate)
{
    if (rate >= 8000 && rate <= 192000) opl_sample_rate = (unsigned int) rate;
}
