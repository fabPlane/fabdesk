export { createSpeechService, pickActive, type SpeechService } from "./service";
export { createFakeSpeechProvider, SpeechProviderError, type SpeechProvider } from "./provider";
export { readSpeechCloud, writeSpeechCloud, DEFAULT_SPEECH_CLOUD_URL } from "./secrets";
export { HARDWARE_VOCABULARY, vocabularyPrompt } from "./vocabulary";
export { createCloudSpeechProvider } from "./cloud";
export { createLocalSpeechProvider, installLocalSpeechModel, localSpeechPaths } from "./local";
