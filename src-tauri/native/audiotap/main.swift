// notchbeat-audiotap: captures ONLY Spotify's audio output with a Core Audio
// process tap (macOS 26+: tap by bundle ID, survives Spotify restarts) and
// streams it to the parent process. It does no analysis and writes nothing to disk.
//
// stdout protocol (little-endian), one message after another:
//   'H' f64 sampleRate, f64 outputLatencySeconds        -- once, first
//   'A' u64 hostTime (mach ticks), u32 frameCount, f32 mono samples[frameCount]
// stderr: one human-readable line on failure. Exit codes:
//   0 parent closed stdin, 2 setup failed, 3 default output device changed.
// The tap is private and unmuted: Spotify keeps playing normally.

import AudioToolbox
import CoreAudio
import Foundation

setvbuf(stdout, nil, _IOFBF, 1 << 16)

func fail(_ message: String, _ status: OSStatus = 0) -> Never {
    FileHandle.standardError.write("audiotap: \(message)\(status != 0 ? " (\(status))" : "")\n".data(using: .utf8)!)
    exit(2)
}

func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func read<T: BitwiseCopyable>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, default value: T) -> T {
    var addr = address(selector, scope)
    var result = value
    var size = UInt32(MemoryLayout<T>.size)
    let status = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &result)
    return status == noErr ? result : value
}

func defaultOutputDevice() -> AudioObjectID {
    read(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice, default: AudioObjectID(kAudioObjectUnknown))
}

func deviceUID(_ device: AudioObjectID) -> String? {
    var addr = address(kAudioDevicePropertyDeviceUID)
    var uid: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &uid) == noErr, let uid else { return nil }
    return uid.takeRetainedValue() as String
}

/// Device + safety offset + first stream latency, in frames, for the output scope.
func outputLatencySeconds(_ device: AudioObjectID) -> Double {
    let rate: Float64 = read(device, kAudioDevicePropertyNominalSampleRate, default: 48000)
    let device: UInt32 = read(device, kAudioDevicePropertyLatency, kAudioObjectPropertyScopeOutput, default: 0)
    let safety: UInt32 = read(device, kAudioDevicePropertySafetyOffset, kAudioObjectPropertyScopeOutput, default: 0)
    return Double(device + safety) / rate
}

func writeAll(_ pointer: UnsafeRawPointer, _ count: Int) {
    if fwrite(pointer, 1, count, stdout) != count { exit(0) } // parent gone
}

// ---- Tap ----

let output = defaultOutputDevice()
guard output != kAudioObjectUnknown, let outputUID = deviceUID(output) else { fail("no default output device") }

let tap = CATapDescription(monoMixdownOfProcesses: [])
tap.bundleIDs = ["com.spotify.client"]
tap.isProcessRestoreEnabled = true
tap.isPrivate = true
tap.muteBehavior = .unmuted
tap.name = "NotchBeat Spotify tap"

var tapID = AudioObjectID(kAudioObjectUnknown)
var status = AudioHardwareCreateProcessTap(tap, &tapID)
guard status == noErr else { fail("could not create process tap", status) }

let aggregate: [String: Any] = [
    kAudioAggregateDeviceNameKey: "NotchBeat Tap",
    kAudioAggregateDeviceUIDKey: "com.notchbeat.tap.\(UUID().uuidString)",
    kAudioAggregateDeviceMainSubDeviceKey: outputUID,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: tap.uuid.uuidString]],
]
var aggregateID = AudioObjectID(kAudioObjectUnknown)
status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
guard status == noErr else {
    AudioHardwareDestroyProcessTap(tapID)
    fail("could not create aggregate device", status)
}

func cleanup() {
    AudioHardwareDestroyAggregateDevice(aggregateID)
    AudioHardwareDestroyProcessTap(tapID)
}

var format: AudioStreamBasicDescription = read(tapID, kAudioTapPropertyFormat, default: AudioStreamBasicDescription())
guard format.mSampleRate > 0, format.mFormatID == kAudioFormatLinearPCM, format.mFormatFlags & kAudioFormatFlagIsFloat != 0 else {
    cleanup()
    fail("unexpected tap format \(format)")
}

// Header
var tag = UInt8(ascii: "H")
var header = (format.mSampleRate, outputLatencySeconds(output))
writeAll(&tag, 1)
withUnsafeBytes(of: &header.0) { writeAll($0.baseAddress!, 8) }
withUnsafeBytes(of: &header.1) { writeAll($0.baseAddress!, 8) }
fflush(stdout)

// ---- IO ----

let queue = DispatchQueue(label: "notchbeat.audiotap", qos: .userInteractive)
var mono = [Float](repeating: 0, count: 4096)
let channels = Int(max(format.mChannelsPerFrame, 1))
let interleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0

var procID: AudioDeviceIOProcID?
status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, inputData, inputTime, _, _ in
    let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
    guard let first = buffers.first, let data = first.mData else { return }
    let perBuffer = Int(first.mDataByteSize) / MemoryLayout<Float>.size
    let frames = interleaved ? perBuffer / channels : perBuffer
    guard frames > 0 else { return }
    if mono.count < frames { mono = [Float](repeating: 0, count: frames) }

    if interleaved {
        let src = data.assumingMemoryBound(to: Float.self)
        for f in 0..<frames {
            var sum: Float = 0
            for c in 0..<channels { sum += src[f * channels + c] }
            mono[f] = sum / Float(channels)
        }
    } else {
        for f in 0..<frames { mono[f] = 0 }
        for buffer in buffers {
            guard let p = buffer.mData?.assumingMemoryBound(to: Float.self) else { continue }
            for f in 0..<frames { mono[f] += p[f] }
        }
        let scale = 1 / Float(buffers.count)
        for f in 0..<frames { mono[f] *= scale }
    }

    var tag = UInt8(ascii: "A")
    var host = inputTime.pointee.mHostTime
    var count = UInt32(frames)
    writeAll(&tag, 1)
    withUnsafeBytes(of: &host) { writeAll($0.baseAddress!, 8) }
    withUnsafeBytes(of: &count) { writeAll($0.baseAddress!, 4) }
    mono.withUnsafeBytes { writeAll($0.baseAddress!, frames * 4) }
    fflush(stdout)
}
guard status == noErr, let procID else {
    cleanup()
    fail("could not create IO proc", status)
}

status = AudioDeviceStart(aggregateID, procID)
guard status == noErr else {
    cleanup()
    fail("could not start capture", status)
}

// The aggregate is bound to the current output device; let the parent restart us on a change.
var defaultAddr = address(kAudioHardwarePropertyDefaultOutputDevice)
AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &defaultAddr, queue) { _, _ in
    AudioDeviceStop(aggregateID, procID)
    cleanup()
    exit(3)
}

for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: queue)
    source.setEventHandler {
        AudioDeviceStop(aggregateID, procID)
        cleanup()
        exit(0)
    }
    source.resume()
    _ = Unmanaged.passRetained(source)
}

// Exit when the parent closes our stdin (or dies).
Thread.detachNewThread {
    while FileHandle.standardInput.availableData.count > 0 {}
    queue.sync {
        AudioDeviceStop(aggregateID, procID)
        cleanup()
    }
    exit(0)
}

dispatchMain()
