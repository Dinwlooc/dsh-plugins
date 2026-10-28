---
name: godot-audio
description: "Godot 音频：播放器、bus、effects、2D/3D 衰减与运行时验证。"
---

# Audio

- 全局音乐用 `AudioStreamPlayer`，空间音效用 2D/3D 版；播放器生命周期跟随声音所有者或音频管理器。
- 至少分 Music/SFX/UI bus；音量存 dB（用户设置做 linear↔dB）。
- 音乐切换淡入淡出；高频 SFX 用播放器池/polyphony，不每次建节点。
- 3D 设置距离/衰减/最大声道，别让听不见的声源占预算。
- 素材导入/loop/stream 类型是资源事实，先读再改。`audio_manage` 建/设/播/停/list；运行时回读播放器状态；听感无法从结构证明时标"需人工试听"。
