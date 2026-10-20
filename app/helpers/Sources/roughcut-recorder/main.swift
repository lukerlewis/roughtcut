// roughcut-recorder: records the screen, the camera and the microphone into a
// folder, plus a log of mouse clicks, for Roughcut to put together. It runs
// on its own (with a menu bar item to stop it), so the editor can close.
//
//   roughcut-recorder list
//       prints the screens, cameras and microphones as JSON
//   roughcut-recorder record <folder> [--screen <id>] [--camera <id>] [--mic <id>]
//       records until Stop in the menu bar, or SIGINT/SIGTERM; then writes
//       <folder>/recording.json and prints `done`
//
// Files: screen.mov (H.264), camera.mov (camera and mic, or mic alone),
// clicks.json ([{t, x, y}] seconds since the screen started, fractions of it).

import AppKit
import AVFoundation
import Foundation
import ScreenCaptureKit

func say(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func cameras() -> [AVCaptureDevice] {
    AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .externalUnknown], mediaType: .video, position: .unspecified).devices
}

func microphones() -> [AVCaptureDevice] {
    AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInMicrophone, .externalUnknown], mediaType: .audio, position: .unspecified).devices
}

// MARK: - list

func list() async {
    var screens: [[String: Any]] = []
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        for (i, d) in content.displays.enumerated() {
            screens.append(["id": String(d.displayID), "name": i == 0 ? "Main screen" : "Screen \(i + 1)", "width": d.width, "height": d.height])
        }
    } catch {
        screens = []
    }
    let json: [String: Any] = [
        "screens": screens,
        "screenAllowed": !screens.isEmpty,
        "cameras": cameras().map { ["id": $0.uniqueID, "name": $0.localizedName] },
        "mics": microphones().map { ["id": $0.uniqueID, "name": $0.localizedName] },
    ]
    let data = try! JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted])
    say(String(data: data, encoding: .utf8)!)
}

// MARK: - record

final class Screen: NSObject, SCStreamOutput, SCStreamDelegate {
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    var stream: SCStream?
    var started: Date?
    var size = CGSize.zero
    let queue = DispatchQueue(label: "screen")

    init(url: URL, width: Int, height: Int) throws {
        writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: max(6_000_000, width * height * 4)],
        ])
        input.expectsMediaDataInRealTime = true
        writer.add(input)
        size = CGSize(width: width, height: height)
    }

    func start(display: SCDisplay, width: Int, height: Int) async throws {
        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true
        config.queueDepth = 6
        let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        self.stream = stream
        try await stream.startCapture()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid else { return }
        // Only complete frames carry a picture; idle ones just repeat the last.
        guard let infos = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = infos.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
        if started == nil {
            guard writer.startWriting() else { return }
            writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sample))
            started = Date()
        }
        if input.isReadyForMoreMediaData { input.append(sample) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(Data("Screen recording stopped: \(error.localizedDescription)\n".utf8))
    }

    func stop() async {
        try? await stream?.stopCapture()
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queue.async {
                guard self.started != nil else { return done.resume() }
                self.input.markAsFinished()
                self.writer.finishWriting { done.resume() }
            }
        }
    }
}

final class Camera: NSObject, AVCaptureFileOutputRecordingDelegate {
    let session = AVCaptureSession()
    let output = AVCaptureMovieFileOutput()
    var started: Date?
    var finished: CheckedContinuation<Void, Never>?

    init(camera: AVCaptureDevice?, mic: AVCaptureDevice?) throws {
        super.init()
        session.beginConfiguration()
        if camera != nil { session.sessionPreset = .high }
        for device in [camera, mic].compactMap({ $0 }) {
            let input = try AVCaptureDeviceInput(device: device)
            if session.canAddInput(input) { session.addInput(input) }
        }
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()
    }

    func start(to url: URL) {
        session.startRunning()
        output.startRecording(to: url, recordingDelegate: self)
    }

    func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL, from connections: [AVCaptureConnection]) {
        started = Date()
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection], error: Error?) {
        if let error = error { FileHandle.standardError.write(Data("Camera: \(error.localizedDescription)\n".utf8)) }
        finished?.resume()
        finished = nil
    }

    func stop() async {
        guard output.isRecording else { return session.stopRunning() }
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            finished = done
            output.stopRecording()
        }
        session.stopRunning()
    }
}

final class Recorder: NSObject {
    let folder: URL
    var screen: Screen?
    var camera: Camera?
    var clicks: [[String: Double]] = []
    var monitor: Any?
    var item: NSStatusItem?
    var timer: Timer?
    var stopping = false
    var frame = CGRect.zero
    let began = Date()

    init(folder: URL) {
        self.folder = folder
    }

    func start(screenID: String?, cameraID: String?, micID: String?) async {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let screenID = screenID {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first(where: { String($0.displayID) == screenID }) ?? content.displays.first else {
                    fail("No screen to record.")
                }
                let mode = CGDisplayCopyDisplayMode(display.displayID)
                let (w, h) = (mode?.pixelWidth ?? display.width * 2, mode?.pixelHeight ?? display.height * 2)
                let s = try Screen(url: folder.appendingPathComponent("screen.mov"), width: w - w % 2, height: h - h % 2)
                try await s.start(display: display, width: w - w % 2, height: h - h % 2)
                screen = s
                frame = CGDisplayBounds(display.displayID)
            } catch {
                fail("Roughcut isn't allowed to record the screen. Turn it on in System Settings, Privacy & Security, Screen Recording. (\(error.localizedDescription))")
            }
        }
        let cam = cameraID.flatMap { id in cameras().first { $0.uniqueID == id } ?? AVCaptureDevice.default(for: .video) }
        let mic = micID.flatMap { id in microphones().first { $0.uniqueID == id } ?? AVCaptureDevice.default(for: .audio) }
        if cam != nil || mic != nil {
            do {
                let c = try Camera(camera: cam, mic: mic)
                c.start(to: folder.appendingPathComponent("camera.mov"))
                camera = c
            } catch {
                fail("Couldn't use the camera or microphone: \(error.localizedDescription)")
            }
        }
        DispatchQueue.main.async {
            // Where Luke clicks, for zooms that follow what he's doing.
            if self.screen != nil {
                self.monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown]) { [weak self] _ in self?.click() }
            }
            self.showItem()
            say("recording")
        }
    }

    func click() {
        guard let started = screen?.started, frame.width > 0 else { return }
        // NSEvent's origin is bottom-left of the main screen; CGDisplayBounds' is top-left.
        let p = NSEvent.mouseLocation
        let mainHeight = NSScreen.screens.first?.frame.height ?? frame.height
        let x = (p.x - frame.minX) / frame.width
        let y = ((mainHeight - p.y) - frame.minY) / frame.height
        guard (0...1).contains(x), (0...1).contains(y) else { return }
        clicks.append(["t": Date().timeIntervalSince(started), "x": x, "y": y])
    }

    func showItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "● Stop recording"
        item.button?.target = self
        item.button?.action = #selector(stopClicked)
        self.item = item
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let s = Int(Date().timeIntervalSince(self.began))
            self.item?.button?.title = String(format: "● %d:%02d  Stop", s / 60, s % 60)
        }
    }

    @objc func stopClicked() {
        Task { await self.stop() }
    }

    func stop() async {
        if stopping { return }
        stopping = true
        await MainActor.run {
            item?.button?.title = "Saving…"
            timer?.invalidate()
            if let m = monitor { NSEvent.removeMonitor(m) }
        }
        let (s, c) = (screen, camera)
        await withTaskGroup(of: Void.self) { group in
            if let s = s { group.addTask { await s.stop() } }
            if let c = c { group.addTask { await c.stop() } }
        }
        var info: [String: Any] = [:]
        if let s = screen, let t = s.started {
            info["screen"] = ["file": "screen.mov", "start": t.timeIntervalSince1970, "width": s.size.width, "height": s.size.height]
            let data = try? JSONSerialization.data(withJSONObject: clicks)
            try? data?.write(to: folder.appendingPathComponent("clicks.json"))
            info["clicks"] = "clicks.json"
        }
        if let c = camera, let t = c.started {
            info["camera"] = ["file": "camera.mov", "start": t.timeIntervalSince1970, "video": c.session.inputs.contains { ($0 as? AVCaptureDeviceInput)?.device.hasMediaType(.video) == true }]
        }
        if let data = try? JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted]) {
            try? data.write(to: folder.appendingPathComponent("recording.json"))
        }
        say("done")
        exit(0)
    }
}

// MARK: - main

let args = CommandLine.arguments
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

switch args.dropFirst().first {
case "list":
    let done = DispatchSemaphore(value: 0)
    Task {
        await list()
        done.signal()
    }
    done.wait()
case "record":
    guard args.count >= 3 else { fail("usage: roughcut-recorder record <folder> [--screen id] [--camera id] [--mic id]") }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let recorder = Recorder(folder: URL(fileURLWithPath: args[2]))
    // Roughcut stops a recording with SIGINT; finish the files first.
    let signals = [SIGINT, SIGTERM].map { sig -> DispatchSourceSignal in
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler { Task { await recorder.stop() } }
        source.resume()
        return source
    }
    Task { await recorder.start(screenID: option("--screen"), cameraID: option("--camera"), micID: option("--mic")) }
    withExtendedLifetime(signals) { app.run() }
default:
    fail("usage: roughcut-recorder list | record <folder> [--screen id] [--camera id] [--mic id]")
}
