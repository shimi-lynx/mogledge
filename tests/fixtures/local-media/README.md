# Local media fixtures

`tone.mp3` and `clip.mp4` are synthetic test signals generated for this repository. No third-party recording or personal data is included. Reproduction with FFmpeg:

```sh
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=44100:duration=3' -c:a libmp3lame -b:a 32k -write_xing 0 -map_metadata -1 tone.mp3
ffmpeg -f lavfi -i 'testsrc2=size=64x48:rate=10:duration=3' -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart -map_metadata -1 clip.mp4
```

The test copies this HTML and its relative assets to temporary authorized and ordinary HTTP roots. It also builds a large MP4 by appending a valid empty `free` box, without retaining that large file in the repository. The HTML keeps no saved state and plays a WebAudio beep only after a click. The test checks playback progress and successful oscillator scheduling, not audible hardware output, background timing, or Native codecs.
