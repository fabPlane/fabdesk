# Voice input

Voice input records a take, converts it to text, and inserts an editable transcript into the composer. It does not send the message automatically.

## macOS on-device recognition

Choose **On-device (macOS)** or **Auto** in Settings → Voice. On macOS 26 with an Xcode 26 build, this uses Apple's SpeechAnalyzer and DictationTranscriber, which work without enabling Siri or keyboard Dictation. Prepare the language model using **Prepare on-device speech** if prompted; macOS downloads and manages the assets from Apple. This is a system-managed model download, not audio uploaded for cloud transcription. Older macOS versions use SFSpeechRecognizer with `requiresOnDeviceRecognition` enabled and require keyboard Dictation to be enabled. No cloud key or separately installed Whisper CLI is needed. macOS must have an offline recognizer available for the selected language. The settings page probes the current app window and native helper rather than trusting the daemon's browser-capability assumption.

Hold Option+Space, speak, and release either key. The first recording needs microphone permission; legacy transcription also needs Speech Recognition permission, while SpeechAnalyzer uses the supplied audio locally. Denied permissions can be changed in System Settings → Privacy & Security. If a language has no offline recognizer, check its Dictation support in System Settings → Keyboard, or select a configured Cloud/Local model provider.

Chromium records the microphone and decodes the recording locally into mono PCM WAV. The main process accepts at most 25 MB of WAV bytes from the main app window, writes a private temporary file, invokes the native recognizer, and removes the file after success, failure, or cancellation. It never accepts a renderer-supplied file path. Escape cancels an in-flight native task; late results are ignored. Native takes are limited to two minutes.

The macOS build compiles `apps/desktop/native/speech.swift` using Xcode's Swift compiler. electron-builder copies the helper to `Resources/speech/` and signs it with the app. The helper carries its own speech usage description; the app declares microphone and speech usage and entitlements. End users do not need Xcode. Non-macOS builds retain the browser/system speech API when available and the existing cloud/local providers.

## Manual checks

1. Start the desktop build, choose On-device, and confirm settings report readiness for the selected language without a cloud key or local model.
2. Allow microphone and Speech Recognition access when prompted. Hold Option+Space and say a short sentence. Release Space first, then repeat releasing Option first. Both takes should stop and produce editable text.
3. Record another take and press Escape while recording or transcribing. No transcript should be inserted, and the native process/temporary audio should be removed.
4. Deny a permission and confirm the app reports how to restore it. An unsupported language must not be reported as ready or silently send audio to a cloud service.
5. Edit a successful transcript, then send it explicitly. Verify normal keyboard input and cloud/local voice providers still work.
