// roughcut-matte: swaps the background behind the person in part of a
// recording, on the Mac (Apple's Vision person segmentation), and writes it
// as a clip with the recording's sound.
//
//   roughcut-matte <recording> <start> <end> <out.mp4> <background>
//
// background is `blur:<strength>`, `color:<#rrggbb>` or `image:<path>`.
// Prints `progress <0..1>` lines on stderr as it goes.

import AVFoundation
import CoreImage
import Foundation
import Vision

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

let args = CommandLine.arguments
guard args.count == 6, let start = Double(args[2]), let end = Double(args[3]), end > start else {
    fail("usage: roughcut-matte <recording> <start> <end> <out.mp4> <blur:N|color:#rrggbb|image:path>")
}
let source = URL(fileURLWithPath: args[1])
let output = URL(fileURLWithPath: args[4])
let background = args[5]

let asset = AVURLAsset(url: source)
guard let videoTrack = asset.tracks(withMediaType: .video).first else { fail("The recording has no video.") }
let audioTrack = asset.tracks(withMediaType: .audio).first
// Frames come out unrotated; the clip keeps the recording's rotation flag.
let (width, height) = (Int(videoTrack.naturalSize.width), Int(videoTrack.naturalSize.height))
let fps = videoTrack.nominalFrameRate > 0 ? videoTrack.nominalFrameRate : 30
let range = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600), end: CMTime(seconds: end, preferredTimescale: 600))

// Reading: frames as BGRA, sound as plain PCM.
let reader: AVAssetReader
do { reader = try AVAssetReader(asset: asset) } catch { fail("Couldn't read the recording: \(error.localizedDescription)") }
reader.timeRange = range
let videoOut = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
videoOut.alwaysCopiesSampleData = false
reader.add(videoOut)
// Sound gets its own reader, so neither waits on the other.
var audioReader: AVAssetReader?
var audioOut: AVAssetReaderTrackOutput?
if let a = audioTrack, let r = try? AVAssetReader(asset: asset) {
    r.timeRange = range
    let out = AVAssetReaderTrackOutput(track: a, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM])
    r.add(out)
    audioReader = r
    audioOut = out
}

// Writing: H.264 at the recording's size, AAC sound.
try? FileManager.default.removeItem(at: output)
let writer: AVAssetWriter
do { writer = try AVAssetWriter(outputURL: output, fileType: .mp4) } catch { fail("Couldn't write the clip: \(error.localizedDescription)") }
let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: max(4_000_000, Int(Double(width * height) * Double(fps) * 0.2))],
])
videoIn.expectsMediaDataInRealTime = false
videoIn.transform = videoTrack.preferredTransform
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: videoIn, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
])
writer.add(videoIn)
var audioIn: AVAssetWriterInput?
if audioOut != nil {
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVNumberOfChannelsKey: 2,
        AVSampleRateKey: 48000,
        AVEncoderBitRateKey: 192_000,
    ])
    input.expectsMediaDataInRealTime = false
    writer.add(input)
    audioIn = input
}

guard reader.startReading() else { fail("Couldn't read the recording: \(reader.error?.localizedDescription ?? "")") }
if let r = audioReader, !r.startReading() { audioOut = nil }
guard writer.startWriting() else { fail("Couldn't write the clip: \(writer.error?.localizedDescription ?? "")") }
writer.startSession(atSourceTime: .zero)

// The new background, made once per frame size.
let context = CIContext(options: [.cacheIntermediates: false])
let extent = CGRect(x: 0, y: 0, width: width, height: height)
var backdropImage: CIImage?
if background.hasPrefix("image:") {
    let path = String(background.dropFirst("image:".count))
    guard let img = CIImage(contentsOf: URL(fileURLWithPath: path)) else { fail("Couldn't open the background picture.") }
    // Fill the frame, cropping the picture's edges as needed.
    let scale = max(CGFloat(width) / img.extent.width, CGFloat(height) / img.extent.height)
    let scaled = img.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let dx = (scaled.extent.width - CGFloat(width)) / 2 + scaled.extent.minX
    let dy = (scaled.extent.height - CGFloat(height)) / 2 + scaled.extent.minY
    backdropImage = scaled.transformed(by: CGAffineTransform(translationX: -dx, y: -dy)).cropped(to: extent)
} else if background.hasPrefix("color:") {
    let hex = background.dropFirst("color:".count).replacingOccurrences(of: "#", with: "")
    let v = UInt32(hex, radix: 16) ?? 0
    let color = CIColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255)
    backdropImage = CIImage(color: color).cropped(to: extent)
}
let blurStrength = background.hasPrefix("blur:") ? Double(background.dropFirst("blur:".count)) ?? 30 : 30

let segmentation = VNGeneratePersonSegmentationRequest()
segmentation.qualityLevel = .balanced
segmentation.outputPixelFormat = kCVPixelFormatType_OneComponent8

func retimed(_ sample: CMSampleBuffer) -> CMSampleBuffer? {
    let count = CMSampleBufferGetNumSamples(sample)
    var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: max(count, 1))
    var got = 0
    CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: timing.count, arrayToFill: &timing, entriesNeededOut: &got)
    let offset = range.start
    for i in 0..<got {
        timing[i].presentationTimeStamp = CMTimeSubtract(timing[i].presentationTimeStamp, offset)
        if timing[i].decodeTimeStamp.isValid { timing[i].decodeTimeStamp = CMTimeSubtract(timing[i].decodeTimeStamp, offset) }
    }
    var out: CMSampleBuffer?
    CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: sample, sampleTimingEntryCount: got, sampleTimingArray: &timing, sampleBufferOut: &out)
    return out
}

let total = end - start
var lastReport = -1.0
func composite(_ frame: CVPixelBuffer) -> CVPixelBuffer? {
    let input = CIImage(cvPixelBuffer: frame)
    let handler = VNImageRequestHandler(cvPixelBuffer: frame, options: [:])
    try? handler.perform([segmentation])
    guard let maskBuffer = segmentation.results?.first?.pixelBuffer else { return frame }
    var mask = CIImage(cvPixelBuffer: maskBuffer)
    mask = mask.transformed(by: CGAffineTransform(scaleX: CGFloat(width) / mask.extent.width, y: CGFloat(height) / mask.extent.height))
    let backdrop = backdropImage ?? input.clampedToExtent().applyingGaussianBlur(sigma: blurStrength).cropped(to: extent)
    let blended = input.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: backdrop, kCIInputMaskImageKey: mask])
    guard let pool = adaptor.pixelBufferPool else { return nil }
    var out: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out)
    guard let buffer = out else { return nil }
    context.render(blended, to: buffer)
    return buffer
}

// Video and sound are written side by side, each when the writer is ready
// for more, so it can interleave them.
let group = DispatchGroup()
group.enter()
videoIn.requestMediaDataWhenReady(on: DispatchQueue(label: "video")) {
    while videoIn.isReadyForMoreMediaData {
        guard let sample = videoOut.copyNextSampleBuffer() else {
            videoIn.markAsFinished()
            group.leave()
            return
        }
        guard let frame = CMSampleBufferGetImageBuffer(sample) else { continue }
        let pts = CMTimeSubtract(CMSampleBufferGetPresentationTimeStamp(sample), range.start)
        if pts.seconds < 0 { continue }
        autoreleasepool {
            if let done = composite(frame) {
                adaptor.append(done, withPresentationTime: pts)
            }
        }
        let progress = min(1, pts.seconds / total)
        if progress - lastReport >= 0.01 {
            lastReport = progress
            FileHandle.standardError.write(Data(String(format: "progress %.3f\n", progress).utf8))
        }
    }
}
if let audioOut = audioOut, let audioIn = audioIn {
    group.enter()
    audioIn.requestMediaDataWhenReady(on: DispatchQueue(label: "audio")) {
        while audioIn.isReadyForMoreMediaData {
            guard let sample = audioOut.copyNextSampleBuffer() else {
                audioIn.markAsFinished()
                group.leave()
                return
            }
            if let moved = retimed(sample), CMSampleBufferGetPresentationTimeStamp(moved).seconds >= -0.05 {
                audioIn.append(moved)
            }
        }
    }
} else {
    audioIn?.markAsFinished()
}
group.wait()
if reader.status == .failed { fail("Couldn't read the recording: \(reader.error?.localizedDescription ?? "")") }

let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()
if writer.status != .completed { fail("Couldn't finish the clip: \(writer.error?.localizedDescription ?? "")") }
FileHandle.standardError.write(Data("progress 1.000\n".utf8))
