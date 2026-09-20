// hangar-dictate — Hangar's on-device dictation helper.
//
// Captures the microphone with AVAudioEngine, converts each buffer to the analyzer's format with
// AVAudioConverter, and feeds SpeechAnalyzer/SpeechTranscriber (macOS 26, on device, no network
// after the model is installed, no API key, no Claude usage). It speaks NDJSON on stdout:
//
//   {"t":"ready"}                                    capture is running
//   {"t":"preparing"}                                the language model is downloading (first use)
//   {"t":"partial","text":"…"}                       live transcript; replaces the previous partial
//   {"t":"final","text":"…"}                         the transcript to insert; then exit 0
//   {"t":"error","code":"…","message":"…"}           then exit 1
//
// EVERYTHING on stdout is one of those lines and nothing else — the main process parses it
// strictly. Diagnostics go to stderr, prefixed `[dictate]`.
//
// stdin: a line `stop` finalizes and exits; `cancel` exits with no final. SIGTERM (and SIGINT, so a
// terminal Ctrl-C behaves the same way) is a cancel, and so is stdin reaching EOF — if the parent
// has gone there is nobody left to insert the text for. A cancel takes effect IMMEDIATELY, in any
// phase, including the permission prompt and a first-use model download; a stop is acted on once
// capture is running.
//
// Flags: --locale <id> (default: the system locale), --max-seconds <n> (default 120, after which it
// finalizes itself so a forgotten session cannot hold the microphone open).

import AVFoundation
import Foundation
import Speech

// MARK: - Output

private let ioLock = NSLock()

/// stderr. Never parsed by anything; it exists for a human reading a failed run.
func note(_ s: String) {
  FileHandle.standardError.write(Data("[dictate] \(s)\n".utf8))
}

/// A JSON string literal. Hand-written rather than JSONSerialization because the key ORDER of the
/// object matters to nothing but a human reading a log, and building the object by hand is the only
/// way to keep `t` first without sorting every key.
func jsonString(_ s: String) -> String {
  var out = "\""
  for scalar in s.unicodeScalars {
    switch scalar {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    default:
      if scalar.value < 0x20 || scalar.value == 0x7F {
        out += String(format: "\\u%04x", scalar.value)
      } else {
        out.unicodeScalars.append(scalar)
      }
    }
  }
  return out + "\""
}

/// A non-terminal line. Holding the lock for the whole write is what keeps a line whole when the
/// results task and a terminal path write at once.
func emit(_ line: String) {
  ioLock.lock()
  FileHandle.standardOutput.write(Data("\(line)\n".utf8))
  ioLock.unlock()
}

/// The only way this process ends. It takes the output lock and exits WITHOUT releasing it, so after
/// the terminal line nothing else can reach stdout — not a late partial from the results task — and
/// a second terminal path (the max-seconds watchdog, a SIGTERM, a failing results stream) blocks
/// here until the process is gone instead of racing it to a different exit status.
func terminate(_ line: String?, status: Int32) -> Never {
  ioLock.lock()
  if let line { FileHandle.standardOutput.write(Data("\(line)\n".utf8)) }
  exit(status)
}

func emitReady() { emit("{\"t\":\"ready\"}") }
func emitPreparing() { emit("{\"t\":\"preparing\"}") }
func emitPartial(_ text: String) { emit("{\"t\":\"partial\",\"text\":\(jsonString(text))}") }
func finalLine(_ text: String) -> String { "{\"t\":\"final\",\"text\":\(jsonString(text))}" }
func errorLine(_ code: String, _ message: String) -> String {
  "{\"t\":\"error\",\"code\":\(jsonString(code)),\"message\":\(jsonString(message))}"
}

// MARK: - Shared state
//
// The audio tap runs on a real-time thread and the results stream on a task; both touch this, so it
// is all behind one lock. "Exactly one terminal line" is not kept here but by `terminate`.

final class Shared: @unchecked Sendable {
  private let lock = NSLock()
  private var finalizedText = ""
  private var volatileText = ""
  private var sawAudio = false
  private var finalizing = false

  func noteAudio() {
    lock.lock(); sawAudio = true; lock.unlock()
  }

  func didSeeAudio() -> Bool {
    lock.lock(); defer { lock.unlock() }
    return sawAudio
  }

  /// A finalized segment. Apple's segments carry their own leading space, so they concatenate.
  func appendFinal(_ text: String) -> String {
    lock.lock(); defer { lock.unlock() }
    finalizedText += text
    volatileText = ""
    return finalizedText
  }

  func setVolatile(_ text: String) -> String {
    lock.lock(); defer { lock.unlock() }
    volatileText = text
    return finalizedText + text
  }

  func transcript() -> String {
    lock.lock(); defer { lock.unlock() }
    return (finalizedText + volatileText).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func beginFinalizing() {
    lock.lock(); finalizing = true; lock.unlock()
  }

  func isFinalizing() -> Bool {
    lock.lock(); defer { lock.unlock() }
    return finalizing
  }
}

let shared = Shared()

/// The one way this process reports a failure. Exit 1 for every code: the LINE carries the meaning,
/// and main reads the line.
func fail(_ code: String, _ message: String) -> Never {
  terminate(errorLine(code, message), status: 1)
}

/// The one way this process reports success — or NO_INPUT, which is what an otherwise successful run
/// means when not one buffer ever reached the analyzer. An empty `final` would say "you said
/// nothing"; the microphone being dead is a different sentence, and the UI has to tell them apart.
func finishWithFinal() -> Never {
  if !shared.didSeeAudio() { fail("NO_INPUT", "No audio buffer reached the transcriber.") }
  terminate(finalLine(shared.transcript()), status: 0)
}

/// No line at all: a cancel hands nothing back, and the OS releases the microphone with the process.
func finishCancelled(_ why: String) -> Never {
  note("cancelled: \(why)")
  terminate(nil, status: 0)
}

// MARK: - Options

struct Options {
  var localeId: String = Locale.current.identifier
  var maxSeconds: Double = 120
}

struct OptionError: Error { let message: String }

let USAGE = "usage: hangar-dictate [--locale <id>] [--max-seconds <n>]"

func parseOptions(_ argv: [String]) throws -> Options {
  var options = Options()
  var i = argv.startIndex
  while i < argv.endIndex {
    switch argv[i] {
    case "--locale":
      i += 1
      guard i < argv.endIndex else { throw OptionError(message: "--locale needs a locale identifier, e.g. --locale en-GB") }
      options.localeId = argv[i]
    case "--max-seconds":
      i += 1
      guard i < argv.endIndex, let n = Double(argv[i]), n.isFinite, n > 0 else {
        throw OptionError(message: "--max-seconds needs a positive number of seconds")
      }
      options.maxSeconds = n
    default:
      throw OptionError(message: "unknown option \(argv[i]); \(USAGE)")
    }
    i += 1
  }
  return options
}

// MARK: - Control (stdin, signals, the clock)

/// Stops only — a stop has to reach the run, which finalizes. A cancel never goes through here: it
/// exits from whichever thread saw it, so it is immediate even while the run is parked in the
/// permission prompt or a model download. AsyncStream buffers, so a stop that arrives before capture
/// starts is kept and acted on the moment it does.
let (stopRequests, stopContinuation) = AsyncStream<String>.makeStream()
nonisolated(unsafe) var signalSources: [DispatchSourceSignal] = []

/// Installed before anything slow, so nothing the parent sends early is lost.
func installControls() {
  var pending = Data()
  FileHandle.standardInput.readabilityHandler = { handle in
    let chunk = handle.availableData
    if chunk.isEmpty {
      // EOF: the parent closed our stdin, or we were run with </dev/null. The handler would
      // otherwise fire again and again on a closed descriptor.
      handle.readabilityHandler = nil
      finishCancelled("stdin closed")
    }
    pending.append(chunk)
    while let nl = pending.firstIndex(of: 0x0A) {
      let line = String(decoding: pending[pending.startIndex..<nl], as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      pending.removeSubrange(pending.startIndex...nl)
      switch line {
      case "stop": stopContinuation.yield("stdin stop")
      case "cancel": finishCancelled("stdin cancel")
      case "": break
      default: note("ignoring unknown stdin command: \(line)")
      }
    }
  }
  for (sig, name) in [(SIGTERM, "SIGTERM"), (SIGINT, "SIGINT")] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
    source.setEventHandler { finishCancelled(name) }
    source.resume()
    signalSources.append(source)
  }
}

// MARK: - The run

/// The locale to transcribe in. `Locale.current.identifier` is ICU-flavoured (`en_GB`) and the
/// supported list is BCP-47 (`en-GB`), so both sides are normalised before they are compared.
///
/// A language-only match is accepted, because the system locale can name a region Apple has no
/// model for (`en_NL`). Which one matters: the supported list is not in any useful order, and
/// `--locale en` took the first English entry — `en-ZA`, measured — and downloaded a model for it.
/// So the same-language candidates are tried in order: the region asked for, the system's region, a
/// model already installed (no download), and only then whatever comes first. No match at all is
/// NO_MODEL, which is honest: there is no model to install.
@available(macOS 26.0, *)
func resolveLocale(_ requestedId: String) async -> Locale? {
  let requested = Locale(identifier: requestedId)
  let key = { (l: Locale) in l.identifier(.bcp47).lowercased() }
  let supported = await SpeechTranscriber.supportedLocales
  if let exact = supported.first(where: { key($0) == key(requested) }) { return exact }

  guard let language = requested.language.languageCode else { return nil }
  let sameLanguage = supported.filter { $0.language.languageCode == language }
  for region in [requested.region, Locale.current.region].compactMap({ $0 }) {
    if let match = sameLanguage.first(where: { $0.region == region }) { return match }
  }
  let installed = Set(await SpeechTranscriber.installedLocales.map(key))
  return sameLanguage.first(where: { installed.contains(key($0)) }) ?? sameLanguage.first
}

@available(macOS 26.0, *)
func run(_ options: Options) async -> Never {
  guard await AVCaptureDevice.requestAccess(for: .audio) else {
    fail("MIC_DENIED", "Microphone access was refused.")
  }

  guard let locale = await resolveLocale(options.localeId) else {
    fail("NO_MODEL", "No transcription model is available for locale \(options.localeId).")
  }
  note("locale: \(locale.identifier(.bcp47))")

  let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
  do {
    let status = await AssetInventory.status(forModules: [transcriber])
    note("asset status: \(status)")
    if status != .installed, let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      emitPreparing()
      try await request.downloadAndInstall()
      note("model installed")
    }
  } catch {
    fail("NO_MODEL", "Could not install the transcription model: \(error)")
  }

  guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
    fail("FAILED", "No audio format is compatible with the transcriber.")
  }

  let (inputStream, inputContinuation) = AsyncStream<AnalyzerInput>.makeStream()
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  do {
    try await analyzer.start(inputSequence: inputStream)
  } catch {
    fail("FAILED", "Could not start the speech analyzer: \(error)")
  }

  let results = Task {
    do {
      for try await result in transcriber.results {
        let text = String(result.text.characters)
        let transcript = result.isFinal ? shared.appendFinal(text) : shared.setVolatile(text)
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { emitPartial(trimmed) }
      }
    } catch {
      // A throwing results stream delivers nothing further, so waiting for max-seconds would only
      // hold the microphone open for a transcript that can no longer arrive. During finalize it is
      // not fatal: whatever was recognised before it is still worth inserting.
      note("results stream failed: \(error)")
      if !shared.isFinalizing() { fail("FAILED", "The transcriber stopped: \(error)") }
    }
  }

  let engine = AVAudioEngine()
  let input = engine.inputNode
  let inputFormat = input.outputFormat(forBus: 0)
  note("input format: \(inputFormat.sampleRate)Hz \(inputFormat.channelCount)ch")
  guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0 else {
    fail("NO_INPUT", "The default input device reports no channels.")
  }
  guard let converter = AVAudioConverter(from: inputFormat, to: analyzerFormat) else {
    fail("FAILED", "No converter from \(inputFormat) to \(analyzerFormat).")
  }

  input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
    let ratio = analyzerFormat.sampleRate / inputFormat.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
    guard let converted = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else { return }
    var error: NSError?
    var supplied = false
    converter.convert(to: converted, error: &error) { _, statusPtr in
      if supplied { statusPtr.pointee = .noDataNow; return nil }
      supplied = true
      statusPtr.pointee = .haveData
      return buffer
    }
    if let error {
      note("convert error: \(error)")
      return
    }
    guard converted.frameLength > 0 else { return }
    shared.noteAudio()
    inputContinuation.yield(AnalyzerInput(buffer: converted))
  }

  engine.prepare()
  do {
    try engine.start()
  } catch {
    // The honest reading of "the engine would not start": there is no working input device, which is
    // exactly what NO_INPUT tells the user to go and look at.
    fail("NO_INPUT", "The audio engine would not start: \(error)")
  }
  emitReady()

  // The cap belongs here as well as in main: a helper nobody is listening to any more must still let
  // go of the microphone by itself.
  let deadline = Task {
    try? await Task.sleep(for: .seconds(options.maxSeconds))
    guard !Task.isCancelled else { return }
    stopContinuation.yield("max-seconds reached")
  }

  var reason = "stop stream ended"
  for await next in stopRequests {
    reason = next
    break
  }
  deadline.cancel()
  note("finalizing: \(reason)")

  engine.stop()
  input.removeTap(onBus: 0)
  inputContinuation.finish()

  shared.beginFinalizing()
  // A second watchdog, because finalize is the one step with no clock of its own: if the analyzer
  // never comes back we still owe stdout a line. 8 s, not 10, because main gives `stop` a 10 s
  // ceiling (plan Task 6) and the helper's own answer should arrive before main gives up on it.
  let finalizeWatchdog = Task {
    try? await Task.sleep(for: .seconds(8))
    guard !Task.isCancelled else { return }
    note("finalize timed out; emitting what was recognised")
    finishWithFinal()
  }
  do {
    try await analyzer.finalizeAndFinishThroughEndOfInput()
  } catch {
    note("finalize failed: \(error)")
  }
  await results.value
  finalizeWatchdog.cancel()
  finishWithFinal()
}

// MARK: - Entry

let options: Options
do {
  options = try parseOptions(Array(CommandLine.arguments.dropFirst()))
} catch let error as OptionError {
  fail("FAILED", error.message)
} catch {
  fail("FAILED", "\(error)")
}

installControls()

guard #available(macOS 26.0, *) else {
  fail("FAILED", "Dictation needs macOS 26 or later.")
}
await run(options)
