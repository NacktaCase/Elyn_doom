// 사운드 백엔드 — vendor 의 i_sound.c 를 **대체한다.**
//
// ── 왜 대체인가 (고치는 게 아니다) ───────────────────────────────────
// vendor 의 i_sound.c 는 `#ifdef FEATURE_SOUND` 에서 `<SDL_mixer.h>` 를 끌어오고
// `use_libsamplerate` 같은 SDL 전용 심볼을 요구한다. 우리에겐 SDL 이 없다.
// 그렇다고 FEATURE_SOUND 를 끄면 sound_module 이 NULL 이라 소리가 아예 안 난다.
//
// 그래서 파일 하나를 통째로 갈아끼운다. **w_file_stdc.c → w_file_memory.c 와
// 같은 수법이고, vendor 트리는 여전히 한 줄도 안 고친다.** 빌드에서 vendor 의
// i_sound.c 를 빼고 이 파일을 넣으면 끝이다.
//
// 모듈 간접층(sound_module_t)도 쓰지 않는다. 고를 백엔드가 하나뿐인데
// 함수 포인터 테이블을 두면 **NULL 역참조로 죽을 자리만 늘어난다** —
// 실제로 그 부류(I_Error 가 종료 함수를 간접 호출하다 트랩)에 한 번 당했다.
// 여기서는 I_*Sound* 를 직접 구현한다.
//
// ── C 와 JS 의 분담 ──────────────────────────────────────────────────
// C 는 **럼프의 위치만** 넘긴다. 디코딩·믹싱·재생은 JS 가 한다.
//   · DOOM sfx 는 8비트 unsigned PCM 이라 브라우저가 바로 못 먹는다.
//     변환은 JS 가 Float32 로 하는 게 짧고, AudioBuffer 캐시도 JS 쪽이 자연스럽다.
//   · 무엇보다 **오디오가 아예 막힌 환경일 수 있다**(sandbox.txt 가 오디오를
//     제한 목록에 올려놨다). JS 가 조용히 무시하면 게임은 그대로 돈다.
//     C 쪽에 재생 상태를 두면 그 폴백이 지저분해진다.
#include <stdint.h>
#include <string.h>

#include "doomtype.h"
#include "i_sound.h"
#include "m_misc.h"
#include "deh_str.h"     // DEH_String — 사운드 이름도 DEH 치환 대상이다
#include "m_config.h"
#include "w_wad.h"
#include "z_zone.h"

// ── JS 가 제공하는 것 ────────────────────────────────────────────────
// 넷 다 실패해도 게임은 계속 돌아야 한다 — JS 쪽이 오디오가 없으면
// 그냥 아무것도 안 하고 0 을 돌려준다.
// ⚠ import_module 만으로는 부족하다. **import_name 까지 있어야** lld 가
//   "미해결 심볼"이 아니라 import 로 본다 (doomgeneric_wasm.c 의 js_now_ms 와
//   같은 형태다). 빠뜨리면 링크가 undefined symbol 로 깨진다.
#define JS_IMPORT(n) __attribute__((import_module("env"), import_name(#n)))

JS_IMPORT(js_snd_start)  extern void js_snd_start(int ptr, int len, int channel, int vol, int sep);
JS_IMPORT(js_snd_stop)   extern void js_snd_stop(int channel);
JS_IMPORT(js_snd_playing) extern int js_snd_playing(int channel);
JS_IMPORT(js_snd_update) extern void js_snd_update(int channel, int vol, int sep);

// ── 설정값 ───────────────────────────────────────────────────────────
// vendor 의 i_sound.c 가 내보내던 것들. m_config.c 가 이름으로 묶으므로
// **하나라도 빠지면 링크가 깨진다.**
int snd_sfxdevice = SNDDEVICE_SB;
int snd_musicdevice = SNDDEVICE_SB;
int snd_samplerate = 44100;
int snd_cachesize = 64 * 1024 * 1024;
int snd_maxslicetime_ms = 28;
char *snd_musiccmd = "";
int snd_sbport = 0;
int snd_sbirq = 0;
int snd_sbdma = 0;
int snd_mport = 0;

static boolean sfx_prefix = true;

// ── 효과음 ───────────────────────────────────────────────────────────

void I_InitSound(boolean use_sfx_prefix)
{
    sfx_prefix = use_sfx_prefix;
}

void I_ShutdownSound(void) { }

int I_GetSfxLumpNum(sfxinfo_t *sfxinfo)
{
    char namebuf[9];

    if (sfx_prefix)
    {
        M_snprintf(namebuf, sizeof(namebuf), "ds%s", DEH_String(sfxinfo->name));
    }
    else
    {
        M_StringCopy(namebuf, DEH_String(sfxinfo->name), sizeof(namebuf));
    }

    // ⚠ W_GetNumForName 이 아니라 **W_CheckNumForName** 이다.
    //   앞엣것은 럼프가 없으면 I_Error 로 죽는다. 효과음이 하나 빠졌다고
    //   게임이 죽으면 안 된다 — 없으면 조용히 안 나는 게 맞다.
    //   (스프라이트에서 이 부류로 이미 한 번 당했다.)
    return W_CheckNumForName(namebuf);
}

int I_StartSound(sfxinfo_t *sfxinfo, int channel, int vol, int sep)
{
    int lump = sfxinfo->lumpnum;
    if (lump < 0) return -1;

    // WAD 가 선형 메모리에 통째로 있고 wad_file_t.mapped 가 채워져 있으므로
    // 이건 복사 없이 **WAD 안을 가리키는 포인터**다(w_file_memory.c 참조).
    void *data = W_CacheLumpNum(lump, PU_STATIC);
    int len = W_LumpLength(lump);
    if (data == NULL || len <= 8) return -1;

    js_snd_start((int)(uintptr_t)data, len, channel, vol, sep);
    return channel;
}

void I_StopSound(int channel) { js_snd_stop(channel); }

boolean I_SoundIsPlaying(int channel)
{
    return js_snd_playing(channel) != 0;
}

void I_UpdateSoundParams(int channel, int vol, int sep)
{
    js_snd_update(channel, vol, sep);
}

// 믹싱을 JS 가 하므로 주기적으로 할 일이 없다.
void I_UpdateSound(void) { }

// 미리 디코딩하지 않는다. JS 가 처음 울릴 때 만들고 캐시한다 —
// 한 판에서 실제로 쓰이는 효과음은 전체의 일부다.
void I_PrecacheSounds(sfxinfo_t *sounds, int num_sounds) { }

// ── 음악 ─────────────────────────────────────────────────────────────
// chocolate-doom 의 OPL 음악 모듈(i_oplmusic.c)에 그대로 넘긴다. DOOM 음악은
// MUS 악보라 신시사이저가 있어야 소리가 되고, 그 신시사이저가 OPL2 다.
// 악기 정의(GENMIDI)와 곡(D_*)은 WAD 에 이미 들어 있다.
//
// 칩 자체는 doom/src/opl_wasm.c 가 돌린다(chocolate 의 opl.c/opl_sdl.c 대체).
//
// ⚠ 모듈 구조체를 거치는 건 여기뿐이다. 효과음 쪽은 백엔드가 하나뿐이라
//   간접층을 걷어냈지만, 음악은 **원본 파일을 그대로 쓰는 게 목적**이라
//   그쪽이 내보내는 형태(music_module_t)를 존중한다.
// 선언은 doomgeneric 의 i_sound.h 것을 그대로 쓴다(non-const). 정의는
// i_oplmusic.c 에서 const 인데, **C 링크는 const 를 따지지 않으므로** 문제없다.
// 자세한 사정은 doom/src/opl_compat.h 2절.

static boolean music_ok = false;

void I_InitMusic(void)
{
    music_ok = music_opl_module.Init();
}

void I_ShutdownMusic(void)
{
    if (music_ok) music_opl_module.Shutdown();
    music_ok = false;
}

void I_SetMusicVolume(int volume)
{
    if (music_ok) music_opl_module.SetMusicVolume(volume);
}

void I_PauseSong(void)  { if (music_ok) music_opl_module.PauseMusic(); }
void I_ResumeSong(void) { if (music_ok) music_opl_module.ResumeMusic(); }

void *I_RegisterSong(void *data, int len)
{
    return music_ok ? music_opl_module.RegisterSong(data, len) : NULL;
}

void I_UnRegisterSong(void *handle)
{
    if (music_ok && handle != NULL) music_opl_module.UnRegisterSong(handle);
}

void I_PlaySong(void *handle, boolean looping)
{
    if (music_ok && handle != NULL) music_opl_module.PlaySong(handle, looping);
}

void I_StopSong(void) { if (music_ok) music_opl_module.StopSong(); }

boolean I_MusicIsPlaying(void)
{
    return music_ok ? music_opl_module.MusicIsPlaying() : false;
}

// ── 설정 바인딩 ──────────────────────────────────────────────────────
// m_config.c 가 이 함수를 부른다. 이름 목록은 vendor 의 i_sound.c 와
// 같아야 한다 — 설정 파일이 그 이름으로 저장되기 때문이다.
void I_BindSoundVariables(void)
{
    M_BindVariable("snd_musicdevice",     &snd_musicdevice);
    M_BindVariable("snd_sfxdevice",       &snd_sfxdevice);
    M_BindVariable("snd_sbport",          &snd_sbport);
    M_BindVariable("snd_sbirq",           &snd_sbirq);
    M_BindVariable("snd_sbdma",           &snd_sbdma);
    M_BindVariable("snd_mport",           &snd_mport);
    M_BindVariable("snd_maxslicetime_ms", &snd_maxslicetime_ms);
    M_BindVariable("snd_musiccmd",        &snd_musiccmd);
    M_BindVariable("snd_samplerate",      &snd_samplerate);
    M_BindVariable("snd_cachesize",       &snd_cachesize);
}
