# 🎵 Sign2Song: Gesture-Controlled Dual-Hand Rhythm & Composition Engine

An immersive, full-screen interactive web application and music game that leverages **Python Flask**, **MediaPipe Hands**, and the **Web Audio API** to transform hand gestures into real-time synthesized chords, harmonies, and melodies.

---

## ✨ Key Features

* **Fullscreen Computer Vision Studio:** Edge-to-edge immersive webcam feed with high-contrast skeleton tracking.
* **Independent Dual-Hand Tracking:** Stable horizontal wrist sorting ensures your **Left Hand (Hand 1)** and **Right Hand (Hand 2)** maintain dedicated instrument channels without cross-over glitches.
* **Real-Time Gesture Composition:** 
  * 🤘 **Rock Gesture:** Triggers warm synth chords (F#m).
  * ✌️ **Peace Gesture:** Triggers melodic harmonies (A Major).
  * ✋ **Open Palm:** Triggers ethereal ambient pads (C#m).
  * ✊ **Fist:** Triggers deep sub-bass frequencies.
* **Dynamic Tilt Volume Control:** Adjust audio volume in real time by tilting your hand sideways.
* **Strict Interactive Audio Gating:** Music and synthesizer voices instantly mute the moment hands are removed or gestures are lost.
* **Synchronized Lyrics & Song HUD:** Live song guidance and dynamic lyric timelines synchronized with your performance.

---

## 🛠️ Tech Stack

* **Backend:** Python, Flask
* **Frontend:** HTML5, Tailwind CSS, JavaScript (ES6)
* **Computer Vision:** Google MediaPipe Hands, Camera Utils
* **Audio Engineering:** Web Audio API (Multi-oscillator synthesis, Biquad low-pass filters, Stereo Panner)

---

## 🚀 Installation & Running Locally

1. **Clone the repository:**
   ```bash
   git clone [https://github.com/Deepsehhh/Sign2Song.git](https://github.com/Deepsehhh/Sign2Song.git)
   cd Sign2Song
