import Foundation
import Speech
import AVFoundation

func reply(_ payload: [String: Any], _ code: Int32 = 0) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    exit(code)
}
let args = CommandLine.arguments
let language = args.count > 2 ? args[2] : "en"
let locale = Locale(identifier: language.replacingOccurrences(of: "_", with: "-"))
#if compiler(>=6.2)
@available(macOS 26.0, *)
func modernSpeech() async {
    guard let selected = await DictationTranscriber.supportedLocale(equivalentTo: locale) else {
        reply(["available": false, "message": "macOS on-device speech does not support this language."])
    }
    let module = DictationTranscriber(locale: selected, preset: .shortDictation)
    let state = await AssetInventory.status(forModules: [module])
    if args.count > 1 && args[1] == "status" {
        reply(["available": state == .installed,
               "needsDownload": state == .supported || state == .downloading,
               "message": state == .installed ? "Uses macOS on-device recognition. Audio stays on this Mac." :
                "Download Apple's speech model for this language using Prepare on-device speech. Siri and keyboard Dictation can stay off."])
    }
    do {
        if args.count > 1 && args[1] == "prepare" {
            guard state != .unsupported else { reply(["error": "macOS on-device speech does not support this language."], 1) }
            _ = try await AssetInventory.reserve(locale: selected)
            if let installation = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
                try await installation.downloadAndInstall()
            }
            let installed = await AssetInventory.status(forModules: [module]) == .installed
            reply(["available": installed, "needsDownload": !installed,
                   "message": installed ? "macOS on-device speech is ready." : "The language model is still being prepared. Try again shortly."])
        }
        guard state == .installed else { reply(["error": "Prepare on-device speech in Settings → Voice first. The language model has not been downloaded."], 1) }
        guard args.count == 4 && args[1] == "transcribe" else { reply(["error": "Expected transcribe, language and audio file."], 1) }
        let analyzer = SpeechAnalyzer(modules: [module])
        async let collected: String = {
            var text = ""
            for try await result in module.results { text += String(result.text.characters) }
            return text
        }()
        do {
            let file = try AVAudioFile(forReading: URL(fileURLWithPath: args[3]))
            try await analyzer.start(inputAudioFile: file, finishAfterFile: true)
            let text = try await collected.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { reply(["error": "No speech was detected. Try speaking a little longer."], 1) }
            reply(["text": text])
        } catch {
            await analyzer.cancelAndFinishNow()
            throw error
        }
    } catch { reply(["error": error.localizedDescription], 1) }
}
if #available(macOS 26.0, *) {
    Task { await modernSpeech() }
    RunLoop.main.run()
    exit(0)
}
#endif
guard let recognizer = SFSpeechRecognizer(locale: locale) else {
    reply(["available": false, "error": "macOS speech recognition does not support this language."])
}
let authorization = SFSpeechRecognizer.authorizationStatus()
let permitted = authorization != .denied && authorization != .restricted
let supported = recognizer.supportsOnDeviceRecognition
if args.count > 1 && args[1] == "status" {
    reply(["available": supported && permitted,
           "message": !permitted ? "Allow Speech Recognition for fabPlane in System Settings → Privacy & Security." :
               supported ? "Uses macOS Dictation. Enable Dictation in System Settings → Keyboard before recording. Audio stays on this Mac." :
               "On-device recognition is unavailable for this language. Enable Dictation for this language in System Settings → Keyboard, then try again."])
}
guard supported else {
    reply(["error": "macOS on-device recognition is unavailable for this language. Enable its Dictation language in System Settings → Keyboard."], 1)
}
guard args.count == 4 else { reply(["error": "Expected transcribe, language and audio file."], 1) }
var recognitionTask: SFSpeechRecognitionTask?
func startRecognition() {
    let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: args[3]))
    // Never allow this provider to send the recording to Apple's servers.
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false
    request.taskHint = .dictation
    request.contextualStrings = ["PCB", "KiCad", "USB-C", "DRC", "ERC", "GPIO", "resistor", "capacitor"]
    recognitionTask = recognizer.recognitionTask(with: request) { result, error in
        if let result = result, result.isFinal {
            let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { reply(["error": "No speech was detected. Try speaking a little longer."], 1) }
            reply(["text": text])
        }
        if let error = error { reply(["error": error.localizedDescription], 1) }
    }
}
SFSpeechRecognizer.requestAuthorization { status in
    DispatchQueue.main.async {
        guard status == .authorized else {
            reply(["error": "Speech Recognition permission was denied. Allow fabPlane in System Settings → Privacy & Security → Speech Recognition."], 1)
        }
        startRecognition()
    }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 90) {
    recognitionTask?.cancel()
    reply(["error": "Speech recognition timed out. Try a shorter recording."], 1)
}
RunLoop.main.run()
