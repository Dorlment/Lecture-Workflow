# Lecture Workflow Windows Audio Companion POC

This directory contains the first Windows-only system-audio probe for Lecture Workflow.
It captures the current default `Render` / `Multimedia` endpoint through WASAPI
loopback, converts the stream to 16 kHz mono PCM signed 16-bit little-endian, and
reports aggregate frame and RMS statistics only.

The probe does not save, upload, transcribe, or log audio content. It does not expose
a WebSocket server and has no connection to the Obsidian plugin in this phase.

## Run the probe

```powershell
dotnet run --project src/LectureWorkflow.AudioCompanion.Windows -- probe
```

Play audio through the current default output device. Press Ctrl+C to stop and release
the WASAPI resources. If the default output changes or becomes unavailable, the probe
stops instead of silently switching devices.

The probe deliberately emits no synthetic silence frames. When the playback stream is
silent, WASAPI loopback may produce no callbacks; the status reporter remains idle
instead of polling in a busy loop. An incomplete final 20 ms frame is discarded when
the probe stops.

## Build and test

```powershell
dotnet restore LectureWorkflow.AudioCompanion.Windows.sln
dotnet build LectureWorkflow.AudioCompanion.Windows.sln
dotnet test LectureWorkflow.AudioCompanion.Windows.sln
```
